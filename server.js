const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket', 'polling'] 
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

const MAZE_SIZE = 15; 
const CELL_SIZE = 100;
let players = {};
let bullets = [];

function generateArenaGrid(size) {
    let grid = Array(size).fill(null).map(() => Array(size).fill(null).map(() => ({ n: true, s: true, e: true, w: true })));
    let visited = Array(size).fill(null).map(() => Array(size).fill(false));
    
    function dfs(r, c) {
        visited[r][c] = true;
        let dirs = [['n', -1, 0, 's'], ['s', 1, 0, 'n'], ['e', 0, 1, 'w'], ['w', 0, -1, 'e']].sort(() => Math.random() - 0.5);
        for (let [dir, dr, dc, opp] of dirs) {
            let nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < size && nc >= 0 && nc < size && !visited[nr][nc]) {
                grid[r][c][dir] = false;
                grid[nr][nc][opp] = false;
                dfs(nr, nc);
            }
        }
    }
    dfs(0, 0);

    for (let r = 1; r < size - 1; r++) {
        for (let c = 1; c < size - 1; c++) {
            if (Math.random() < 0.5) { grid[r][c].n = false; grid[r-1][c].s = false; }
            if (Math.random() < 0.5) { grid[r][c].w = false; grid[r][c-1].e = false; }
        }
    }
    return grid;
}
const maze = generateArenaGrid(MAZE_SIZE);

const namesList = ["Sniper", "Viper", "Slayer", "Phoenix", "Titan", "Specter", "Reaper", "Hunter", "Rogue", "Blaze", "Frost", "Wolf", "Ghost", "Shadow", "Apex", "Kratos"];
function getRandomName(prefix = "") {
    return `${prefix}${namesList[Math.floor(Math.random() * namesList.length)]}#${Math.floor(1000 + Math.random() * 9000)}`;
}

function getRandomCellCenter() {
    return { x: Math.floor(Math.random() * MAZE_SIZE) * CELL_SIZE + 50, y: Math.floor(Math.random() * MAZE_SIZE) * CELL_SIZE + 50 };
}

function isWallBlocking(x, y) {
    let c = Math.floor(x / CELL_SIZE);
    let r = Math.floor(y / CELL_SIZE);
    if (c < 0 || c >= MAZE_SIZE || r < 0 || r >= MAZE_SIZE) return true;
    
    let cell = maze[r][c];
    let ox = x % CELL_SIZE;
    let oy = y % CELL_SIZE;

    if (cell.e && ox > 92) return true;
    if (cell.w && ox < 8) return true;
    if (cell.s && oy > 92) return true;
    if (cell.n && oy < 8) return true;
    return false;
}

function hasLineOfSight(x0, y0, x1, y1) {
    let dist = Math.hypot(x1 - x0, y1 - y0);
    if (dist > 500) return false; 
    let steps = Math.min(10, Math.ceil(dist / 40)); 
    for (let i = 1; i < steps; i++) {
        let t = i / steps;
        if (isWallBlocking(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false;
    }
    return true;
}

function initBots() {
    players = {}; 
    for (let i = 0; i < 20; i++) {
        let id = `b_n_${i}`; let spawn = getRandomCellCenter();
        players[id] = { id, name: getRandomName(""), x: spawn.x, y: spawn.y, angle: Math.random()*6, health: 5, isBot: true, isHard: false, lastShot: 0, vx: 2, vy: 0 };
    }
    for (let i = 0; i < 5; i++) {
        let id = `b_e_${i}`; let spawn = getRandomCellCenter();
        players[id] = { id, name: getRandomName("EXTREME_"), x: spawn.x, y: spawn.y, angle: Math.random()*6, health: 5, isBot: true, isHard: true, lastShot: 0, vx: 4, vy: 0 };
    }
}
initBots();

function updateGame() {
    for (let i = bullets.length - 1; i >= 0; i--) {
        let b = bullets[i];
        b.x += b.vx; b.y += b.vy;
        
        if (isWallBlocking(b.x, b.y)) { bullets.splice(i, 1); continue; }

        for (let pId in players) {
            let p = players[pId];
            if (pId !== b.ownerId && Math.abs(p.x - b.x) < 16 && Math.abs(p.y - b.y) < 16) {
                p.health -= 1;
                bullets.splice(i, 1);
                if (p.health <= 0) delete players[pId];
                break;
            }
        }
    }

    let now = Date.now();
    
    for (let id in players) {
        let p = players[id];
        if (!p.isBot) continue;

        let speed = p.isHard ? 4.2 : 2.4;
        let fireCooldown = p.isHard ? 200 : 850;
        let detectionRange = p.isHard ? 650 : 400;

        // FIXED: First, scan for an enemy that is in range AND has a completely clear vision profile
        let visibleTarget = null; 
        let minDist = detectionRange;

        for (let tId in players) {
            if (tId !== id) {
                let d = Math.hypot(players[tId].x - p.x, players[tId].y - p.y);
                if (d < minDist) {
                    // Check vision BEFORE allowing tracking mechanics
                    if (hasLineOfSight(p.x, p.y, players[tId].x, players[tId].y)) {
                        minDist = d;
                        visibleTarget = players[tId];
                    }
                }
            }
        }

        if (visibleTarget) {
            // COMBAT STATE: Fires up ONLY when a clean, uninterrupted path to target is verified
            p.angle = Math.atan2(visibleTarget.y - p.y, visibleTarget.x - p.x);
            p.vx = Math.cos(p.angle) * speed; 
            p.vy = Math.sin(p.angle) * speed;

            if (now - p.lastShot > fireCooldown) {
                bullets.push({ ownerId: id, x: p.x, y: p.y, angle: p.angle, vx: Math.cos(p.angle)*12, vy: Math.sin(p.angle)*12, speed: 12 });
                p.lastShot = now;
            }
        } else {
            // EXPLORATION PATROL STATE: Continues wandering smoothly through hallways if vision is blocked
            if ((Math.abs(p.vx) < 0.1 && Math.abs(p.vy) < 0.1) || Math.random() < 0.02) {
                let rAngle = Math.floor(Math.random() * 4) * (Math.PI / 2);
                p.vx = Math.cos(rAngle) * speed; 
                p.vy = Math.sin(rAngle) * speed;
            }
        }

        // Apply robust axis thresholds sliding
        if (!isWallBlocking(p.x + p.vx, p.y)) p.x += p.vx; else p.vx = -p.vx;
        if (!isWallBlocking(p.x, p.y + p.vy)) p.y += p.vy; else p.vy = -p.vy;

        if (p.vx !== 0 || p.vy !== 0) p.angle = Math.atan2(p.vy, p.vx);
    }

    io.emit('gameState', { players, bullets });
}

setInterval(updateGame, 1000 / 30);

io.on('connection', (socket) => {
    let spawn = getRandomCellCenter();
    players[socket.id] = { id: socket.id, name: getRandomName(""), x: spawn.x, y: spawn.y, angle: 0, health: 5, isBot: false };
    socket.emit('init', { maze, size: MAZE_SIZE, cellSize: CELL_SIZE, id: socket.id });

    socket.on('move', (data) => {
        let p = players[socket.id]; if (!p) return;
        p.angle = data.angle;
        let mx = Math.cos(p.angle) * data.speed; let my = Math.sin(p.angle) * data.speed;
        if (!isWallBlocking(p.x + mx, p.y)) p.x += mx;
        if (!isWallBlocking(p.x, p.y + my)) p.y += my;
    });

    socket.on('shoot', () => {
        let p = players[socket.id]; if (!p) return;
        bullets.push({ ownerId: socket.id, x: p.x, y: p.y, angle: p.angle, vx: Math.cos(p.angle)*12, vy: Math.sin(p.angle)*12, speed: 12 });
    });

    socket.on('disconnect', () => { delete players[socket.id]; });
});

server.listen(process.env.PORT || 3000);
