# Neon Strike Arena (Three.js + Socket.IO)

A modular cyberpunk-themed multiplayer FPS starter built with **HTML/CSS/JS**, **Three.js**, **Node.js**, **Express**, and **Socket.IO**.

## Features included
- First-person mouse look, WASD, jump, sprint, crouch
- Team deathmatch game loop, timer, kill/death, respawn, score
- Hitscan-style replicated projectile visuals + server-authoritative damage
- Basic lag smoothing with interpolation for remote players
- AI bots to keep lobbies active
- Futuristic HUD (health/ammo/kills/score/timer/crosshair)
- Mobile fire/jump buttons
- Dynamic lighting, fog, shadows, and neon sci-fi arena styling
- Basic anti-cheat input sanitization and server authority for HP/score
- Modular folder layout for extending weapons, maps, and modes

## Project structure

```
client/
  index.html
  styles.css
  src/
    main.js
server/
  src/
    index.js
shared/
  constants.js
package.json
README.md
```

## Setup

1. Install deps:
   ```bash
   npm install
   ```
2. Run local dev:
   ```bash
   npm run dev
   ```
3. Open client at `http://localhost:5173` (server runs on `http://localhost:3000`).

## Deployment

### Render (single service)
- Create a Web Service.
- Build command: `npm install`
- Start command: `npm start`
- Expose port `3000`.

### Vercel
- Recommended split architecture:
  - Deploy `client/` as static site.
  - Deploy `server/src/index.js` to a Node host (Render/Railway/Fly) because long-lived Socket.IO servers are not ideal in serverless function mode.
- Set client Socket.IO endpoint to your server URL.

## Extending
- Add new weapons in `shared/constants.js` and attach weapon models/animations in `client/src/main.js`.
- Add new map generators or GLTF maps in `client/src/` modules.
- Add ranked matchmaking, authoritative rewind/lag compensation, and persistent profiles in `server/src/`.

## Production-hardening checklist
- Add authentication + signed session tokens.
- Add server rewind hit validation.
- Move physics to fixed-step authoritative simulation.
- Add asset compression, texture LODs, and draw-call batching.
- Add cheat telemetry and rate-limits.
