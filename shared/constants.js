export const TICK_RATE = 30;
export const MAP_SIZE = 480;
export const TEAM_A = 'A';
export const TEAM_B = 'B';
export const MAX_HEALTH = 100;
export const RESPAWN_DELAY_MS = 3000;
export const MATCH_LENGTH_MS = 10 * 60 * 1000;

export const STARTING_WEAPON = 'pistol';
export const KILL_REWARD = 10;

export const WEAPONS = {
  pistol: {
    name: 'Basic Pistol',
    damage: 20,
    fireRateMs: 1000,
    magazine: 10,
    reloadMs: 1400,
    spread: 0.01,
    recoil: 0.0015,
    range: 100
  },
  rifle: {
    name: 'Rifle',
    damage: 18,
    fireRateMs: 100,
    magazine: 30,
    reloadMs: 1800,
    spread: 0.012,
    recoil: 0.003,
    range: 160
  },
  smg: {
    name: 'SMG',
    damage: 11,
    fireRateMs: 70,
    magazine: 40,
    reloadMs: 1600,
    spread: 0.02,
    recoil: 0.002,
    range: 100
  },
  sniper: {
    name: 'Sniper',
    damage: 80,
    fireRateMs: 950,
    magazine: 6,
    reloadMs: 2400,
    spread: 0.001,
    recoil: 0.008,
    range: 280
  }
};

export const WEAPON_COSTS = { pistol: 0, rifle: 120, smg: 90, sniper: 180 };
