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
let maze = [];
let isResettingMatch = false;
let matchStartTime = 0; // TRACKS GRACE PERIOD RESET

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
        for (let c = 1; r < size - 1 && c < size - 1; c++) {
            if (Math.random() < 0.5) { grid[r][c].n = false; grid[r-1][c].s = false; }
            if (Math.random() < 0.5) { grid[r][c].w = false; grid[r][c-1].e = false; }
        }
    }
    return grid;
}

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

    if (cell.e && ox > 85) return true;
    if (cell.w && ox < 15) return true;
    if (cell.s && oy > 85) return true;
    if (cell.n && oy < 15) return true;
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

function startNewMatchRound() {
    isResettingMatch = false;
    matchStartTime = Date.now(); // Start 3-second grace window clock
    bullets = [];
    maze = generateArenaGrid(MAZE_SIZE);

    let currentHumans = {};
    for (let id in players) {
        if (players[id] && !players[id].isBot) {
            let spawn = getRandomCellCenter();
            currentHumans[id] = {
                id: id, name: players[id].name, x: spawn.x, y: spawn.y, angle: 0, health: 5, isBot: false
            };
        }
    }
    players = currentHumans;

    // Hard-load 20 Normal Bots
    for (let i = 0; i < 20; i++) {
        let botId = `bot_normal_${i}`;
        let spawn = getRandomCellCenter();
        players[botId] = {
            id: botId, name: getRandomName(""), x: spawn.x, y: spawn.y, angle: 0, health: 5,
            isBot: true, isHard: false, lastShot: 0,
            currentDir: ['n', 's', 'e', 'w'][Math.floor(Math.random() * 4)]
        };
    }

    // Hard-load 5 Extreme Bots
    for (let i = 0; i < 5; i++) {
        let botId = `bot_extreme_${i}`;
        let spawn = getRandomCellCenter();
        players[botId] = {
            id: botId, name: getRandomName("EXTREME_"), x: spawn.x, y: spawn.y, angle: 0, health: 5,
            isBot: true, isHard: true, lastShot: 0,
            currentDir: ['n', 's', 'e', 'w'][Math.floor(Math.random() * 4)]
        };
    }

    io.emit('newRound', { maze, size: MAZE_SIZE, cellSize: CELL_SIZE });
}

startNewMatchRound();

function updateGame() {
    let now = Date.now();
    let isGracePeriodActive = (now - matchStartTime) < 3000; // 3-second immunity

    // Projectiles
    for (let i = bullets.length - 1; i >= 0; i--) {
        let b = bullets[i];
        b.x += b.vx; b.y += b.vy;
        
        if (isWallBlocking(b.x, b.y)) { bullets.splice(i, 1); continue; }

        for (let pId in players) {
            let p = players[pId];
            if (pId !== b.ownerId && Math.abs(p.x - b.x) < 18 && Math.abs(p.y - b.y) < 18) {
                p.health -= 1;
                bullets.splice(i, 1);
                if (p.health <= 0) delete players[pId];
                break;
            }
        }
    }

    let totalAlive = Object.keys(players).length;

    // ONLY check win condition if grace period is OVER to let everyone load
    if (!isGracePeriodActive && totalAlive <= 1 && !isResettingMatch) {
        isResettingMatch = true;
        let lastSurvivorName = totalAlive === 1 ? Object.values(players)[0].name : "NONE";
        io.emit('roundEndingAnnounce', { winner: lastSurvivorName });
        setTimeout(() => { startNewMatchRound(); }, 5000);
        return;
    }

    for (let id in players) {
        let p = players[id];
        if (!p || !p.isBot) continue;

        let speed = p.isHard ? 4.0 : 2.2;
        let fireCooldown = p.isHard ? 200 : 850;
        let detectionRange = p.isHard ? 600 : 350;

        let visibleTarget = null; 
        let minDist = detectionRange;

        for (let tId in players) {
            if (tId !== id) {
                let d = Math.hypot(players[tId].x - p.x, players[tId].y - p.y);
                if (d < minDist && hasLineOfSight(p.x, p.y, players[tId].x, players[tId].y)) {
                    minDist = d;
                    visibleTarget = players[tId];
                }
            }
        }

        let vx = 0, vy = 0;

        if (visibleTarget) {
            p.angle = Math.atan2(visibleTarget.y - p.y, visibleTarget.x - p.x);
            let dx = visibleTarget.x - p.x;
            let dy = visibleTarget.y - p.y;
            
            if (Math.abs(dx) > Math.abs(dy)) {
                p.currentDir = dx > 0 ? 'e' : 'w';
            } else {
                p.currentDir = dy > 0 ? 's' : 'n';
            }

            // BOTS CANONLY SHOOT IF GRACE PERIOD IS OVER
            if (!isGracePeriodActive && (now - p.lastShot > fireCooldown)) {
                bullets.push({ ownerId: id, x: p.x, y: p.y, angle: p.angle, vx: Math.cos(p.angle)*12, vy: Math.sin(p.angle)*12 });
                p.lastShot = now;
            }
        }

        if (p.currentDir === 'n') vy = -speed;
        if (p.currentDir === 's') vy = speed;
        if (p.currentDir === 'w') vx = -speed;
        if (p.currentDir === 'e') vx = speed;

        if (isWallBlocking(p.x + vx, p.y + vy)) {
            let directions = ['n', 's', 'e', 'w'].sort(() => Math.random() - 0.5);
            for (let dir of directions) {
                let testVx = 0, testVy = 0;
                if (dir === 'n') testVy = -speed;
                if (dir === 's') testVy = speed;
                if (dir === 'w') testVx = -speed;
                if (dir === 'e') testVx = speed;

                if (!isWallBlocking(p.x + testVx, p.y + testVy)) {
                    p.currentDir = dir; vx = testVx; vy = testVy; break;
                }
            }
        }

        p.x += vx; p.y += vy;
        if (vx !== 0 || vy !== 0) p.angle = Math.atan2(vy, vx);
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
        // HUMANS CAN ONLY SHOOT IF GRACE PERIOD IS OVER
        if ((Date.now() - matchStartTime) >= 3000) {
            bullets.push({ ownerId: socket.id, x: p.x, y: p.y, angle: p.angle, vx: Math.cos(p.angle)*12, vy: Math.sin(p.angle)*12 });
        }
    });

    socket.on('disconnect', () => { delete players[socket.id]; });
});

server.listen(process.env.PORT || 3000);
