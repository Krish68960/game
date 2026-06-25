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
const MAP_SIZE = MAZE_SIZE * CELL_SIZE; 
let players = {};
let bullets = [];

function generateMaze(size) {
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
    return grid;
}
const maze = generateMaze(MAZE_SIZE);

const namesList = ["Ghost", "Shadow", "Viper", "Phoenix", "Titan", "Specter", "Reaper", "Alpha", "Omega", "Hunter", "Rogue", "Blaze", "Frost", "Wolf", "Ninja", "Slayer", "Apex", "Vortex", "Hazard", "Cipher", "Bullet", "Sniper"];

function getRandomName(prefix = "") {
    const baseName = namesList[Math.floor(Math.random() * namesList.length)];
    const randomTag = Math.floor(1000 + Math.random() * 9000);
    return `${prefix}${baseName}#${randomTag}`;
}

// FIX 1: Grid-Centered Spawning. Forces entities to start perfectly in the center of an open hallway cell.
function getGridCenteredSpawn() {
    let r = Math.floor(Math.random() * MAZE_SIZE);
    let c = Math.floor(Math.random() * MAZE_SIZE);
    return { 
        x: (c * CELL_SIZE) + (CELL_SIZE / 2), 
        y: (r * CELL_SIZE) + (CELL_SIZE / 2) 
    };
}

// FIX 2: Re-engineered completely clean wall boundary collision. Removes complex float radius traps.
function checkWallCollision(x, y, radius = 10) {
    if (x - radius < 0 || x + radius > MAP_SIZE || y - radius < 0 || y + radius > MAP_SIZE) return true;

    let cellX = Math.floor(x / CELL_SIZE);
    let cellY = Math.floor(y / CELL_SIZE);
    
    if (cellX < 0 || cellX >= MAZE_SIZE || cellY < 0 || cellY >= MAZE_SIZE) return true;
    let cell = maze[cellY][cellX];

    let cellLeft = cellX * CELL_SIZE;
    let cellRight = cellLeft + CELL_SIZE;
    let cellTop = cellY * CELL_SIZE;
    let cellBottom = cellTop + CELL_SIZE;

    // Strict boundary block checks
    if (cell.w && (x - radius) < (cellLeft + 4)) return true;
    if (cell.e && (x + radius) > (cellRight - 4)) return true;
    if (cell.n && (y - radius) < (cellTop + 4)) return true;
    if (cell.s && (y + radius) > (cellBottom - 4)) return true;

    return false;
}

function hasLineOfSight(x0, y0, x1, y1) {
    let dist = Math.hypot(x1 - x0, y1 - y0);
    let steps = Math.ceil(dist / 20); 
    for (let i = 1; i < steps; i++) {
        let t = i / steps;
        if (checkWallCollision(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, 5)) {
            return false;
        }
    }
    return true;
}

function initBots() {
    players = {}; // Reset container cleanly
    for (let i = 0; i < 25; i++) {
        const isHard = i >= 20; 
        const botId = `bot_${i}_${Date.now()}`;
        const spawn = getGridCenteredSpawn();
        const targetWaypoint = getGridCenteredSpawn();
        
        players[botId] = {
            id: botId,
            name: getRandomName(isHard ? "ULTRA_" : ""),
            x: spawn.x,
            y: spawn.y,
            angle: Math.random() * Math.PI * 2,
            health: 5,
            isBot: true,
            isHard: isHard,
            lastShot: 0,
            targetX: targetWaypoint.x,
            targetY: targetWaypoint.y,
            stuckTimer: 0
        };
    }
}
initBots();

function updateGame() {
    // Bullets Core
    for (let i = bullets.length - 1; i >= 0; i--) {
        let b = bullets[i];
        b.x += Math.cos(b.angle) * b.speed;
        b.y += Math.sin(b.angle) * b.speed;

        if (checkWallCollision(b.x, b.y, 3)) {
            bullets.splice(i, 1);
            continue;
        }

        for (let pId in players) {
            let p = players[pId];
            if (pId !== b.ownerId) {
                if (Math.hypot(p.x - b.x, p.y - b.y) < 16) {
                    p.health -= 1;
                    bullets.splice(i, 1);
                    if (p.health <= 0) { delete players[pId]; }
                    break;
                }
            }
        }
    }

    // BOT AI MOVEMENT CORE
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

        let speed = p.isHard ? 3.0 : 1.6; 
        let detectionRange = p.isHard ? 500 : 250;
        let fireCooldown = p.isHard ? 450 : 1400;

        let targetVisible = false;
        if (closestTarget && minDist < detectionRange) {
            targetVisible = hasLineOfSight(p.x, p.y, closestTarget.x, closestTarget.y);
        }

        if (closestTarget && targetVisible) {
            // TARGET ACQUIRED MODE
            p.angle = Math.atan2(closestTarget.y - p.y, closestTarget.x - p.x);
            let moveX = Math.cos(p.angle) * speed;
            let moveY = Math.sin(p.angle) * speed;
            
            // Axis separation sliding logic
            if (!checkWallCollision(p.x + moveX, p.y, 10)) p.x += moveX;
            if (!checkWallCollision(p.x, p.y + moveY, 10)) p.y += moveY;

            if (now - p.lastShot > fireCooldown) {
                bullets.push({ ownerId: id, x: p.x, y: p.y, angle: p.angle, speed: 7.5 });
                p.lastShot = now;
            }
        } else {
            // ADVANCED MAP TRAVEL MODE
            let distToWaypoint = Math.hypot(p.targetX - p.x, p.targetY - p.y);
            
            if (distToWaypoint < 25 || p.stuckTimer > 40) {
                let nextNode = getGridCenteredSpawn();
                p.targetX = nextNode.x;
                p.targetY = nextNode.y;
                p.stuckTimer = 0;
            }

            p.angle = Math.atan2(p.targetY - p.y, p.targetX - p.x);
            let moveX = Math.cos(p.angle) * speed;
            let moveY = Math.sin(p.angle) * speed;

            let successX = false;
            let successY = false;

            if (!checkWallCollision(p.x + moveX, p.y, 10)) { p.x += moveX; successX = true; }
            if (!checkWallCollision(p.x, p.y + moveY, 10)) { p.y += moveY; successY = true; }

            if (!successX && !successY) {
                p.stuckTimer++;
                // If hitting a hard corner block, rotate exactly 90 degrees to immediately exit the corner pocket
                p.angle += (Math.random() > 0.5 ? Math.PI / 2 : -Math.PI / 2);
                let escapeNode = getGridCenteredSpawn();
                p.targetX = escapeNode.x;
                p.targetY = escapeNode.y;
            }
        }
    }

    io.emit('gameState', { players, bullets });
}

setInterval(updateGame, 1000 / 30);

io.on('connection', (socket) => {
    let spawn = getGridCenteredSpawn();
    players[socket.id] = { id: socket.id, name: getRandomName(), x: spawn.x, y: spawn.y, angle: 0, health: 5, isBot: false };
    socket.emit('init', { maze, size: MAZE_SIZE, cellSize: CELL_SIZE, id: socket.id });

    socket.on('move', (data) => {
        let p = players[socket.id];
        if (!p) return;
        p.angle = data.angle;
        let moveX = Math.cos(p.angle) * data.speed;
        let moveY = Math.sin(p.angle) * data.speed;
        if (!checkWallCollision(p.x + moveX, p.y, 10)) p.x += moveX;
        if (!checkWallCollision(p.x, p.y + moveY, 10)) p.y += moveY;
    });

    socket.on('shoot', () => {
        let p = players[socket.id];
        if (!p) return;
        bullets.push({ ownerId: socket.id, x: p.x, y: p.y, angle: p.angle, speed: 8 });
    });

    socket.on('disconnect', () => { delete players[socket.id]; });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Crash-proof server running on port ${PORT}`));
