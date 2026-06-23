"""
═══════════════════════════════════════════════════════
  ARC  —  Flask Backend
═══════════════════════════════════════════════════════
  HOW TO RUN:
      pip install flask numpy
      python app.py
  Then open: http://localhost:5000

  Physics implemented:
    • Two-body Keplerian (RK4)
    • J2 Earth oblateness
    • Atmospheric drag  (exponential density model)
    • Sun + Moon third-body gravity
    • Solar Radiation Pressure  (cannonball, eclipse-aware)
    • General Relativity — IERS/PPN Schwarzschild term
    • Lense-Thirring frame-dragging (optional, tiny)
    • Sun position (USNO low-precision)
    • Moon position (simplified circular ephemeris)
    • Eclipse detection (cylindrical shadow model)
    • J2 secular drift rates (nodal + apsidal)
    • GEO eclipse-season detection
    • True anomaly computed per timestep from state vector
═══════════════════════════════════════════════════════
"""

from flask import Flask, render_template, jsonify, request
import numpy as np
from datetime import datetime, timezone

app = Flask(__name__)

# ═══════════════════════════════════════════════
#  CONSTANTS
# ═══════════════════════════════════════════════
EARTH_RADIUS  = 6378.0
EARTH_MU      = 3.9860043543609598e5
C_LIGHT       = 299792.458
OMEGA_EARTH   = 7.2921150e-5
J2            = 1.08262668e-3
GM_SUN        = 1.32712440018e11
GM_MOON       = 4902.800
AU            = 1.495978707e8
MOON_DIST     = 384400.0
P_SRP         = 4.56e-6
I_EARTH       = 8.0345e37
M_EARTH       = 5.972e24
A_KERR_KM     = (I_EARTH * OMEGA_EARTH) / (M_EARTH * C_LIGHT * 1000.0)

# ═══════════════════════════════════════════════
#  ORBIT PRESETS  (all editable after load)
# ═══════════════════════════════════════════════
PRESETS = {
    'LEO': {
        'a':6778.,'e':0.001,'i':51.6,'raan':0.,'aop':0.,'nu':0.,
        'note':'ISS-like (~400 km). Drag & J₂ dominate. All parameters editable.'
    },
    'MEO': {
        'a':26561.,'e':0.001,'i':55.,'raan':0.,'aop':0.,'nu':0.,
        'note':'GPS-like (~20 200 km). J₂ + Sun/Moon + GR timing. All parameters editable.'
    },
    'GEO': {
        'a':42164.,'e':0.0002,'i':0.,'raan':0.,'aop':0.,'nu':0.,
        'note':'Geostationary. Sun/Moon + J₂ + SRP dominate. All parameters editable.'
    },
    'Molniya': {
        'a':26554.,'e':0.74,'i':63.4,'raan':0.,'aop':270.,'nu':0.,
        'note':'Critical inclination 63.4° — J₂ apsidal drift ≈ 0. All parameters editable.'
    },
    'Custom': {
        'a':16001.,'e':0.004,'i':98.23,'raan':301.98,'aop':292.66,'nu':90.9,
        'note':'Fully user-defined orbit.'
    },
}

# ═══════════════════════════════════════════════
#  ROTATION HELPERS
# ═══════════════════════════════════════════════
def _Rz(t):
    c,s=np.cos(t),np.sin(t)
    return np.array([[c,-s,0],[s,c,0],[0,0,1]])

def _Rx(t):
    c,s=np.cos(t),np.sin(t)
    return np.array([[1,0,0],[0,c,-s],[0,s,c]])

# ═══════════════════════════════════════════════
#  COE → STATE VECTOR
# ═══════════════════════════════════════════════
def coe_to_state(a,e,i_d,raan_d,aop_d,nu_d,mu=EARTH_MU):
    i,raan,aop,nu = np.radians([i_d,raan_d,aop_d,nu_d])
    p   = a*(1-e**2)
    r   = p/(1+e*np.cos(nu))
    h   = np.sqrt(mu*p)
    rpf = r*np.array([np.cos(nu),np.sin(nu),0.])
    vpf = mu/h*np.array([-np.sin(nu),e+np.cos(nu),0.])
    Q   = _Rz(raan)@_Rx(i)@_Rz(aop)
    return np.r_[Q@rpf, Q@vpf]

# ═══════════════════════════════════════════════
#  STATE VECTOR → TRUE ANOMALY  (degrees, 0-360)
# ═══════════════════════════════════════════════
def state_to_nu(r_vec, v_vec, mu=EARTH_MU):
    """Compute true anomaly from ECI position+velocity."""
    r  = np.linalg.norm(r_vec)
    v  = np.linalg.norm(v_vec)
    # Eccentricity vector
    e_vec = ((v**2 - mu/r)*r_vec - np.dot(r_vec, v_vec)*v_vec) / mu
    e     = np.linalg.norm(e_vec)
    if e < 1e-10:
        # Circular orbit: use argument of latitude instead
        nu = np.arctan2(r_vec[1], r_vec[0])
    else:
        cos_nu = np.clip(np.dot(e_vec, r_vec) / (e * r), -1.0, 1.0)
        nu = np.arccos(cos_nu)
        # Quadrant check: if radial velocity negative, past apoapsis
        if np.dot(r_vec, v_vec) < 0:
            nu = 2*np.pi - nu
    return float(np.degrees(nu) % 360.0)

# ═══════════════════════════════════════════════
#  SUN POSITION  (USNO low-precision, ECI unit vector)
# ═══════════════════════════════════════════════
def sun_hat(dt):
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    n   = (dt-datetime(2000,1,1,12,tzinfo=timezone.utc)).total_seconds()/86400.
    L   = np.radians((280.460+0.9856474*n)%360)
    g   = np.radians((357.528+0.9856003*n)%360)
    lam = L+np.radians(1.915)*np.sin(g)+np.radians(.02)*np.sin(2*g)
    eps = np.radians(23.439-4e-7*n)
    return np.array([np.cos(lam), np.cos(eps)*np.sin(lam), np.sin(eps)*np.sin(lam)])

# ═══════════════════════════════════════════════
#  MOON POSITION  (simplified circular ephemeris, km)
# ═══════════════════════════════════════════════
def moon_vec(dt):
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    t = (dt-datetime(2000,1,1,12,tzinfo=timezone.utc)).total_seconds()
    L = np.radians(218.32)+2*np.pi/27.321661/86400*t
    inc = np.radians(28.58)
    return np.array([MOON_DIST*np.cos(L),
                     MOON_DIST*np.sin(L)*np.cos(inc),
                     MOON_DIST*np.sin(L)*np.sin(inc)])

# ═══════════════════════════════════════════════
#  ECLIPSE  (cylindrical shadow model)
# ═══════════════════════════════════════════════
def eclipsed(r_vec, sh):
    proj = np.dot(r_vec, sh)
    if proj > 0:
        return False
    return np.linalg.norm(r_vec - proj*sh) < EARTH_RADIUS

# ═══════════════════════════════════════════════
#  PERTURBATION ACCELERATIONS  (km/s²)
# ═══════════════════════════════════════════════
def acc_j2(r):
    x,y,z = r
    rn = np.linalg.norm(r)
    f  = -1.5*J2*EARTH_MU*EARTH_RADIUS**2/rn**5
    zr = (z/rn)**2
    return f*np.array([x*(1-5*zr),y*(1-5*zr),z*(3-5*zr)])

_ATM = [
    (0,1.225,7.249),(25,3.899e-2,6.349),(100,5.297e-7,5.877),
    (150,2.07e-9,22.523),(200,2.789e-10,37.105),(300,2.418e-11,53.628),
    (400,3.725e-12,58.515),(500,6.967e-13,63.822),(600,1.454e-13,71.835),
    (700,3.614e-14,88.667),(800,1.17e-14,124.64),(900,5.245e-15,181.05),
    (1000,3.019e-15,268.),
]
def atm_density(alt):
    if alt>1000: h0,r0,H=_ATM[-1]
    elif alt<0:  h0,r0,H=_ATM[0]
    else:
        h0,r0,H=_ATM[-1]
        for k in range(len(_ATM)-1):
            if _ATM[k][0]<=alt<_ATM[k+1][0]: h0,r0,H=_ATM[k]; break
    return r0*np.exp(-(alt-h0)/H)

def acc_drag(r,v,Cd,Am):
    rn  = np.linalg.norm(r)
    rho = atm_density(rn-EARTH_RADIUS)
    vr  = v - np.cross([0,0,OMEGA_EARTH],r)
    vrm = np.linalg.norm(vr)
    return -0.5*Cd*Am*rho*(vrm*1e3)*(vr*1e3)/1e3

def acc_3body(r,s,gm):
    d = s-r
    return gm*(d/np.linalg.norm(d)**3 - s/np.linalg.norm(s)**3)

def acc_srp(sh, ecl, Cr, Am):
    return np.zeros(3) if ecl else -P_SRP*Cr*Am*sh/1e3

def acc_gr(r,v):
    rn = np.linalg.norm(r); v2=np.dot(v,v); rv=np.dot(r,v); c2=C_LIGHT**2
    return EARTH_MU/(c2*rn**3)*((4*EARTH_MU/rn-v2)*r+4*rv*v)

def acc_lt(r,v):
    J  = np.array([0.,0.,A_KERR_KM])
    rn = np.linalg.norm(r); c2=C_LIGHT**2
    return 2*EARTH_MU/(c2*rn**3)*(3/rn**2*np.dot(r,J)*np.cross(r,v)+np.cross(v,J))

# ═══════════════════════════════════════════════
#  FULL ODE
# ═══════════════════════════════════════════════
def ode(state, sh, mv, f, amp):
    r,v = state[:3], state[3:]
    a   = -EARTH_MU*r/np.linalg.norm(r)**3
    if f['j2']:   a += acc_j2(r)
    if f['drag']: a += acc_drag(r,v,f['Cd'],f['Am_drag'])
    if f['sun']:  a += acc_3body(r,sh*AU,GM_SUN)
    if f['moon']: a += acc_3body(r,mv,GM_MOON)
    if f['srp']:  a += acc_srp(sh, eclipsed(r,sh), f['Cr'], f['Am_srp'])
    if f['gr']:   a += amp*acc_gr(r,v)
    if f['lt']:   a += amp*acc_lt(r,v)
    return np.r_[v,a]

def rk4(state, dt, sh, mv, f, amp):
    k1 = ode(state,           sh,mv,f,amp)
    k2 = ode(state+.5*dt*k1,  sh,mv,f,amp)
    k3 = ode(state+.5*dt*k2,  sh,mv,f,amp)
    k4 = ode(state+dt*k3,     sh,mv,f,amp)
    return state+dt/6*(k1+2*k2+2*k3+k4)

# ═══════════════════════════════════════════════
#  PROPAGATOR  — now also returns true_anomaly[]
# ═══════════════════════════════════════════════
def propagate(a,e,i,raan,aop,nu0, sh,mv, f,amp, n_orbits,
              steps=2000, out_pts=1200):
    state = coe_to_state(a,e,i,raan,aop,nu0)
    T     = 2*np.pi*np.sqrt(a**3/EARTH_MU)
    dt    = T/steps
    N     = int(steps*n_orbits)
    pos   = np.zeros((N+1,3)); pos[0]=state[:3]
    nu_arr = [state_to_nu(state[:3], state[3:])]
    times = np.arange(N+1) * dt
    ecl   = [eclipsed(state[:3],sh)]

    for k in range(N):
        state = rk4(state,dt,sh,mv,f,amp)
        if not np.all(np.isfinite(state)) or np.linalg.norm(state[:3])<EARTH_RADIUS:
            pos=pos[:k+2]; times=times[:k+2]; ecl=ecl[:k+2]; nu_arr=nu_arr[:k+2]; break
        pos[k+1]=state[:3]
        ecl.append(eclipsed(state[:3],sh))
        nu_arr.append(state_to_nu(state[:3], state[3:]))

    # downsample
    if len(pos)>out_pts:
        idx = np.linspace(0,len(pos)-1,out_pts).astype(int)
        pos=pos[idx]; times=times[idx]
        ecl=[ecl[i] for i in idx]
        nu_arr=[nu_arr[i] for i in idx]

    return pos, times, ecl, T, nu_arr

def gmst_rad(dt):
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    jd = dt.timestamp()/86400.0 + 2440587.5
    T = (jd - 2451545.0)/36525.0
    gmst_deg = 280.46061837 + 360.98564736629*(jd - 2451545.0) \
               + 0.000387933*T**2 - T**3/38710000.0
    return float(np.radians(gmst_deg % 360.0))

# ═══════════════════════════════════════════════
#  J2 SECULAR RATES  (deg/day)
# ═══════════════════════════════════════════════
def j2_rates(a,e,i_d):
    n = np.sqrt(EARTH_MU/a**3)
    p = a*(1-e**2)
    i = np.radians(i_d)
    f = 1.5*n*J2*(EARTH_RADIUS/p)**2
    to_dpd = np.degrees(86400.)
    return -f*np.cos(i)*to_dpd, f*.5*(5*np.cos(i)**2-1)*to_dpd

# ═══════════════════════════════════════════════
#  PERTURBATION MAGNITUDES  (m/s²)
# ═══════════════════════════════════════════════
def perturb_table(a,e,i,raan,aop,nu, sh,mv, f):
    state  = coe_to_state(a,e,i,raan,aop,nu)
    r,v    = state[:3],state[3:]
    ecl    = eclipsed(r,sh)
    a0     = np.linalg.norm(-EARTH_MU*r/np.linalg.norm(r)**3)
    rows   = [{'name':'Newtonian (2-body)','mag':a0*1e3,'rel':1.}]
    accels = {
        'J₂ oblateness':      acc_j2(r)            if f['j2']   else None,
        'Atmospheric Drag':   acc_drag(r,v,f['Cd'],f['Am_drag']) if f['drag'] else None,
        'Sun (3rd body)':     acc_3body(r,sh*AU,GM_SUN) if f['sun'] else None,
        'Moon (3rd body)':    acc_3body(r,mv,GM_MOON)   if f['moon'] else None,
        'Solar Rad. Pressure':acc_srp(sh,ecl,f['Cr'],f['Am_srp']) if f['srp'] else None,
        'GR Schwarzschild':   acc_gr(r,v)           if f['gr']   else None,
        'Lense-Thirring':     acc_lt(r,v)           if f['lt']   else None,
    }
    for name,ac in accels.items():
        if ac is not None:
            m = np.linalg.norm(ac)*1e3
            rows.append({'name':name,'mag':m,'rel':m/(a0*1e3)})
    return rows

# ═══════════════════════════════════════════════
#  FLASK ROUTES
# ═══════════════════════════════════════════════
@app.route('/')
def index():
    return render_template('index.html', presets=PRESETS)


@app.route('/api/propagate', methods=['POST'])
def api_propagate():
    d = request.json

    a    = float(d['a'])
    e    = float(d['e'])
    i    = float(d['i'])
    raan = float(d['raan'])
    aop  = float(d['aop'])
    nu   = float(d['nu'])
    n_orbits = int(d.get('n_orbits', 2))
    amp  = float(d.get('gr_amp', 1.0))

    forces = {
        'j2':    bool(d.get('j2',   True)),
        'drag':  bool(d.get('drag', True)),
        'sun':   bool(d.get('sun',  True)),
        'moon':  bool(d.get('moon', True)),
        'srp':   bool(d.get('srp',  True)),
        'gr':    bool(d.get('gr',   True)),
        'lt':    bool(d.get('lt',   False)),
        'Cd':    float(d.get('Cd',  2.2)),
        'Am_drag': float(d.get('Am_drag', 0.01)),
        'Cr':    float(d.get('Cr',  1.3)),
        'Am_srp': float(d.get('Am_srp', 0.02)),
    }

    try:
        dt = datetime.fromisoformat(d.get('datetime','2026-03-20T00:00:00')).replace(tzinfo=timezone.utc)
    except Exception:
        dt = datetime(2026,3,20,tzinfo=timezone.utc)

    sh = sun_hat(dt)
    mv = moon_vec(dt)

    pos, times, ecl, T, nu_arr = propagate(a,e,i,raan,aop,nu, sh,mv, forces, amp, n_orbits)
    ecl = [bool(x) for x in ecl]

    r_now  = a*(1-e**2)/(1+e*np.cos(np.radians(nu)))
    v_now  = np.sqrt(EARTH_MU*(2/r_now-1/a))
    ap_h   = a*(1+e)-EARTH_RADIUS
    pe_h   = a*(1-e)-EARTH_RADIUS
    T_hr   = T/3600
    raan_d, aop_d = j2_rates(a,e,i)

    decl   = np.degrees(np.arcsin(np.clip(sh[2],-1,1)))
    limit  = np.degrees(np.arctan(EARTH_RADIUS/42164.))
    geo_ecl_possible = bool(abs(decl) < limit)

    ptable = perturb_table(a,e,i,raan,aop,nu, sh,mv, forces)

    return jsonify({
        'positions':         pos.tolist(),
        'times_s':           times.tolist(),
        'eclipse':           ecl,
        'true_anomaly_deg':  nu_arr,          # <-- NEW: per-step true anomaly
        'sun_hat':           sh.tolist(),
        'moon_hat':          (mv/np.linalg.norm(mv)).tolist(),
        'moon_vec':          mv.tolist(),
        'gmst0_rad':         gmst_rad(dt),
        'period_hr':         round(T_hr,3),
        'speed_kms':         round(v_now,4),
        'apogee_km':         round(ap_h,1),
        'perigee_km':        round(pe_h,1),
        'raan_rate':         round(raan_d,5),
        'aop_rate':          round(aop_d,5),
        'geo_eclipse_possible': geo_ecl_possible,
        'sun_decl':          round(decl,3),
        'geo_limit':         round(limit,3),
        'perturb_table':     ptable,
    })


@app.route('/api/presets')
def api_presets():
    return jsonify(PRESETS)


if __name__ == '__main__':
    app.run(debug=False, port=5000)