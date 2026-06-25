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
    let r = Math.floor(Math.random() * MAZE_SIZE);
    let c = Math.floor(Math.random() * MAZE_SIZE);
    return { x: c * CELL_SIZE + 50, y: r * CELL_SIZE + 50 };
}

function isWallBlocking(x, y, dx, dy) {
    let c = Math.floor(x / CELL_SIZE);
    let r = Math.floor(y / CELL_SIZE);
    if (c < 0 || c >= MAZE_SIZE || r < 0 || r >= MAZE_SIZE) return true;
    
    let cell = maze[r][c];
    let offsetX = x % CELL_SIZE;
    let offsetY = y % CELL_SIZE;

    if (dx > 0 && cell.e && offsetX > 92) return true;
    if (dx < 0 && cell.w && offsetX < 8) return true;
    if (dy > 0 && cell.s && offsetY > 92) return true;
    if (dy < 0 && cell.n && offsetY < 8) return true;

    if (cell.e && offsetX > 96) return true;
    if (cell.w && offsetX < 4) return true;
    if (cell.s && offsetY > 96) return true;
    if (cell.n && offsetY < 4) return true;

    return false;
}

function hasLineOfSight(x0, y0, x1, y1) {
    let dist = Math.hypot(x1 - x0, y1 - y0);
    if (dist > 600) return false; 
    let steps = Math.ceil(dist / 15); 
    for (let i = 1; i < steps; i++) {
        let t = i / steps;
        let cx = x0 + (x1 - x0) * t;
        let cy = y0 + (y1 - y0) * t;
        if (isWallBlocking(cx, cy, 0, 0)) return false;
    }
    return true;
}

// FIXED: Hard-isolated loop generation block guarantees exactly 20 normal and 5 extreme bots load cleanly
function initBots() {
    players = {}; // Complete wipe before allocation
    
    // Part A: Deploy 20 Normal Bots (Indices 0 to 19)
    for (let i = 0; i < 20; i++) {
        const botId = `bot_normal_${i}`;
        const spawn = getRandomCellCenter();
        players[botId] = {
            id: botId,
            name: getRandomName(""),
            x: spawn.x, y: spawn.y,
            angle: Math.random() * Math.PI * 2,
            health: 5, isBot: true, isHard: false, lastShot: 0,
            vx: 0, vy: 0
        };
    }

    // Part B: Deploy 5 Extreme Hard Bots (Indices 20 to 24)
    for (let i = 20; i < 25; i++) {
        const botId = `bot_extreme_${i}`;
        const spawn = getRandomCellCenter();
        players[botId] = {
            id: botId,
            name: getRandomName("EXTREME_"),
            x: spawn.x, y: spawn.y,
            angle: Math.random() * Math.PI * 2,
            health: 5, isBot: true, isHard: true, lastShot: 0,
            vx: 0, vy: 0
        };
    }
}
initBots();

function updateGame() {
    // Projectiles Verification Core
    for (let i = bullets.length - 1; i >= 0; i--) {
        let b = bullets[i];
        let nextX = b.x + Math.cos(b.angle) * b.speed;
        let nextY = b.y + Math.sin(b.angle) * b.speed;

        let bc = Math.floor(nextX / CELL_SIZE);
        let br = Math.floor(nextY / CELL_SIZE);
        
        if (bc < 0 || bc >= MAZE_SIZE || br < 0 || br >= MAZE_SIZE || isWallBlocking(nextX, nextY, Math.cos(b.angle), Math.sin(b.angle))) {
            bullets.splice(i, 1);
            continue;
        }

        b.x = nextX;
        b.y = nextY;

        for (let pId in players) {
            let p = players[pId];
            if (pId !== b.ownerId && Math.hypot(p.x - b.x, p.y - b.y) < 18) {
                p.health -= 1;
                bullets.splice(i, 1);
                if (p.health <= 0) delete players[pId];
                break;
            }
        }
    }

    // BOT BEHAVIOR EXECUTION ENGINE
    let now = Date.now();
    for (let id in players) {
        let p = players[id];
        if (!p.isBot) continue;

        let closestTarget = null;
        let minDist = Infinity;
        for (let tId in players) {
            if (tId !== id) {
                let dist = Math.hypot(players[tId].x - p.x, players[tId].y - p.y);
                if (dist < minDist) { minDist = dist; closestTarget = players[tId]; }
            }
        }

        // BUFFED: Extreme bots now run at 4.2 speed and shoot every 200ms with hyper precision
        let speed = p.isHard ? 4.2 : 2.2;
        let fireCooldown = p.isHard ? 200 : 900;

        let targetVisible = closestTarget && hasLineOfSight(p.x, p.y, closestTarget.x, closestTarget.y);

        if (targetVisible) {
            p.angle = Math.atan2(closestTarget.y - p.y, closestTarget.x - p.x);
            p.vx = Math.cos(p.angle) * speed;
            p.vy = Math.sin(p.angle) * speed;

            if (now - p.lastShot > fireCooldown) {
                // Extreme bots get zero gun spread sway for max challenge accuracy
                let variance = p.isHard ? 0 : (Math.random() - 0.5) * 0.05;
                bullets.push({ ownerId: id, x: p.x, y: p.y, angle: p.angle + variance, speed: 12 });
                p.lastShot = now;
            }
        } else {
            if (Math.abs(p.vx) < 0.2 && Math.abs(p.vy) < 0.2 || Math.random() < 0.02) {
                let randAngle = Math.floor(Math.random() * 4) * (Math.PI / 2); 
                p.vx = Math.cos(randAngle) * speed;
                p.vy = Math.sin(randAngle) * speed;
            }
        }

        if (!isWallBlocking(p.x + p.vx, p.y, p.vx, 0)) p.x += p.vx; else p.vx = -p.vx * 0.5;
        if (!isWallBlocking(p.x, p.y + p.vy, 0, p.vy)) p.y += p.vy; else p.vy = -p.vy * 0.5;
        
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
        let p = players[socket.id];
        if (!p) return;
        p.angle = data.angle;
        let mx = Math.cos(p.angle) * data.speed;
        let my = Math.sin(p.angle) * data.speed;
        if (!isWallBlocking(p.x + mx, p.y, mx, 0)) p.x += mx;
        if (!isWallBlocking(p.x, p.y + my, 0, my)) p.y += my;
    });

    socket.on('shoot', () => {
        let p = players[socket.id];
        if (!p) return;
        bullets.push({ ownerId: socket.id, x: p.x, y: p.y, angle: p.angle, speed: 12 });
    });

    socket.on('disconnect', () => { delete players[socket.id]; });
});

server.listen(process.env.PORT || 3000);
