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

// NEW: Generates a high-flow Braided Arena Maze (breaks dead ends to allow maximum bot movement)
function generateArenaMaze(size) {
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

    // BRAIDING PROCESS: Permanently tear down 40% of the walls to create open corridors and loop circuits
    for (let r = 1; r < size - 1; r++) {
        for (let c = 1; c < size - 1; c++) {
            if (Math.random() < 0.40) {
                grid[r][c].n = false; grid[r-1][c].s = false;
                grid[r][c].w = false; grid[r][c-1].e = false;
            }
        }
    }
    return grid;
}
const maze = generateArenaMaze(MAZE_SIZE);

const namesList = ["Sniper", "Viper", "Slayer", "Phoenix", "Titan", "Specter", "Reaper", "Alpha", "Omega", "Hunter", "Rogue", "Blaze", "Frost", "Wolf", "Ninja", "Kratos", "Zeus", "Hazard", "Cipher", "Bullet", "Ghost", "Shadow"];

function getRandomName(prefix = "") {
    return `${prefix}${namesList[Math.floor(Math.random() * namesList.length)]}#${Math.floor(1000 + Math.random() * 9000)}`;
}

function getGridCenteredSpawn() {
    let r = Math.floor(Math.random() * MAZE_SIZE);
    let c = Math.floor(Math.random() * MAZE_SIZE);
    return { x: (c * CELL_SIZE) + 50, y: (r * CELL_SIZE) + 50 };
}

// ULTRA LIGHTWEIGHT COLLISION: Lowered radius to 8px so bots never get clipped or squeezed by narrow corners
function checkWallCollision(x, y, radius = 8) {
    if (x - radius < 4 || x + radius > MAP_SIZE - 4 || y - radius < 4 || y + radius > MAP_SIZE - 4) return true;

    let cellX = Math.floor(x / CELL_SIZE);
    let cellY = Math.floor(y / CELL_SIZE);
    
    if (cellX < 0 || cellX >= MAZE_SIZE || cellY < 0 || cellY >= MAZE_SIZE) return true;
    let cell = maze[cellY][cellX];

    let cellLeft = cellX * CELL_SIZE;
    let cellRight = cellLeft + CELL_SIZE;
    let cellTop = cellY * CELL_SIZE;
    let cellBottom = cellTop + CELL_SIZE;

    if (cell.w && (x - radius) < (cellLeft + 2)) return true;
    if (cell.e && (x + radius) > (cellRight - 2)) return true;
    if (cell.n && (y - radius) < (cellTop + 2)) return true;
    if (cell.s && (y + radius) > (cellBottom - 2)) return true;

    return false;
}

function hasLineOfSight(x0, y0, x1, y1) {
    let dist = Math.hypot(x1 - x0, y1 - y0);
    let steps = Math.ceil(dist / 25); 
    for (let i = 1; i < steps; i++) {
        let t = i / steps;
        if (checkWallCollision(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, 4)) return false;
    }
    return true;
}

function initBots() {
    players = {};
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
    // Projectiles Processing Engine
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

    // HARDCORE INTELLIGENT BOT ENGINE
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

        // BUFFED STATS: Increased move speeds and laser speeds across all tiers
        let speed = p.isHard ? 4.5 : 2.8; 
        let detectionRange = p.isHard ? 700 : 400;
        let fireCooldown = p.isHard ? 250 : 800; // Ultra bots shoot like an absolute machine gun

        let targetVisible = false;
        if (closestTarget && minDist < detectionRange) {
            targetVisible = hasLineOfSight(p.x, p.y, closestTarget.x, closestTarget.y);
        }

        if (closestTarget && targetVisible) {
            // COMBAT PURSUIT SPRINT MODE
            p.angle = Math.atan2(closestTarget.y - p.y, closestTarget.x - p.x);
            
            let moveX = Math.cos(p.angle) * speed;
            let moveY = Math.sin(p.angle) * speed;
            
            // Ultra-responsive wall sliding physics configuration
            if (!checkWallCollision(p.x + moveX, p.y, 8)) p.x += moveX;
            if (!checkWallCollision(p.x, p.y + moveY, 8)) p.y += moveY;

            if (now - p.lastShot > fireCooldown) {
                // Predictive Offset: Adds slight accuracy scaling to laser weapon discharges
                let spread = (Math.random() - 0.5) * (p.isHard ? 0.05 : 0.15);
                bullets.push({ ownerId: id, x: p.x, y: p.y, angle: p.angle + spread, speed: p.isHard ? 11 : 8.5 });
                p.lastShot = now;
            }
        } else {
            // HIGH-SPEED MAP SEARCH MODE
            let distToWaypoint = Math.hypot(p.targetX - p.x, p.targetY - p.y);
            
            if (distToWaypoint < 30 || p.stuckTimer > 25) {
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

            if (!checkWallCollision(p.x + moveX, p.y, 8)) { p.x += moveX; successX = true; }
            if (!checkWallCollision(p.x, p.y + moveY, 8)) { p.y += moveY; successY = true; }

            if (!successX && !successY) {
                p.stuckTimer++;
                // Instant reflex pivot: Forces immediate alternate corridor redirection
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
        if (!checkWallCollision(p.x + moveX, p.y, 8)) p.x += moveX;
        if (!checkWallCollision(p.x, p.y + moveY, 8)) p.y += moveY;
    });

    socket.on('shoot', () => {
        let p = players[socket.id];
        if (!p) return;
        bullets.push({ ownerId: socket.id, x: p.x, y: p.y, angle: p.angle, speed: 10 });
    });

    socket.on('disconnect', () => { delete players[socket.id]; });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Hardcore Arena Engine Online on port ${PORT}`));
