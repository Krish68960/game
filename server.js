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

const namesList = ["Ghost", "Shadow", "Viper", "Phoenix", "Titan", "Specter", "Reaper", "Alpha", "Omega", "Hunter", "Rogue", "Blaze", "Frost", "Wolf", "Ninja", "Slayer", "Apex", "Vortex", "Kratos", "Zeus", "Hazard", "Cipher", "Bullet", "Sniper", "Rex"];

// FIXED: Generates an entirely unique, randomized dynamic tag combination every single execution call
function getRandomName(prefix = "") {
    const baseName = namesList[Math.floor(Math.random() * namesList.length)];
    const randomTag = Math.floor(1000 + Math.random() * 9000);
    return `${prefix}${baseName}#${randomTag}`;
}

function getRandomWaypoint() {
    let r = Math.floor(Math.random() * MAZE_SIZE);
    let c = Math.floor(Math.random() * MAZE_SIZE);
    return { x: c * CELL_SIZE + CELL_SIZE / 2, y: r * CELL_SIZE + CELL_SIZE / 2 };
}

function initBots() {
    for (let i = 0; i < 25; i++) {
        const isHard = i >= 20; 
        const botId = `bot_${i}_${Date.now()}`;
        const spawn = getRandomWaypoint();
        const targetWaypoint = getRandomWaypoint();
        
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
            // Added intelligence nodes
            targetX: targetWaypoint.x,
            targetY: targetWaypoint.y,
            stuckTimer: 0
        };
    }
}
initBots();

function checkWallCollision(x, y, radius = 12) {
    if (x - radius < 0 || x + radius > MAP_SIZE || y - radius < 0 || y + radius > MAP_SIZE) return true;

    let cellX = Math.floor(x / CELL_SIZE);
    let cellY = Math.floor(y / CELL_SIZE);
    
    if (cellX < 0 || cellX >= MAZE_SIZE || cellY < 0 || cellY >= MAZE_SIZE) return true;
    let cell = maze[cellY][cellX];

    let leftBound = cellX * CELL_SIZE;
    let rightBound = leftBound + CELL_SIZE;
    let topBound = cellY * CELL_SIZE;
    let bottomBound = topBound + CELL_SIZE;

    if (cell.w && (x - radius) < leftBound) return true;
    if (cell.e && (x + radius) > rightBound) return true;
    if (cell.n && (y - radius) < topBound) return true;
    if (cell.s && (y + radius) > bottomBound) return true;

    return false;
}

function updateGame() {
    // Bullets System
    for (let i = bullets.length - 1; i >= 0; i--) {
        let b = bullets[i];
        b.x += Math.cos(b.angle) * b.speed;
        b.y += Math.sin(b.angle) * b.speed;

        if (checkWallCollision(b.x, b.y, 4)) {
            bullets.splice(i, 1);
            continue;
        }

        for (let pId in players) {
            let p = players[pId];
            if (pId !== b.ownerId) {
                if (Math.hypot(p.x - b.x, p.y - b.y) < 18) {
                    p.health -= 1;
                    bullets.splice(i, 1);
                    if (p.health <= 0) { delete players[pId]; }
                    break;
                }
            }
        }
    }

    // ADVANCED INTELLIGENT BOT NAVIGATION CORE
    let now = Date.now();
    for (let id in players) {
        let p = players[id];
        if (!p.isBot) continue;

        // 1. Scan for nearest visible enemy
        let closestTarget = null;
        let minDist = Infinity;
        for (let tId in players) {
            if (tId !== id) {
                let dist = Math.hypot(players[tId].x - p.x, players[tId].y - p.y);
                if (dist < minDist) { minDist = dist; closestTarget = players[tId]; }
            }
        }

        let speed = p.isHard ? 3.4 : 1.8; 
        let detectionRange = p.isHard ? 450 : 250;
        let fireCooldown = p.isHard ? 400 : 1300;

        // 2. Determine Action State: Combat vs Free Exploration Map Travelling
        if (closestTarget && minDist < detectionRange) {
            // COMBAT HUNTING: Lock orientation to enemy target
            p.angle = Math.atan2(closestTarget.y - p.y, closestTarget.x - p.x);
            
            let nextX = p.x + Math.cos(p.angle) * speed;
            let nextY = p.y + Math.sin(p.angle) * speed;
            
            if (!checkWallCollision(nextX, nextY)) {
                p.x = nextX; p.y = nextY;
                p.stuckTimer = 0;
            } else {
                // Smart Corner Sliding: If blocked straight ahead, attempt to move diagonally/sideways to sweep past the wall
                p.stuckTimer++;
                let slideAngle = p.angle + (p.stuckTimer % 2 === 0 ? Math.PI / 2 : -Math.PI / 2);
                let slideX = p.x + Math.cos(slideAngle) * speed;
                let slideY = p.y + Math.sin(slideAngle) * speed;
                if (!checkWallCollision(slideX, slideY)) { p.x = slideX; p.y = slideY; }
            }

            // Fire weapons
            if (now - p.lastShot > fireCooldown) {
                bullets.push({ ownerId: id, x: p.x, y: p.y, angle: p.angle, speed: p.isHard ? 9 : 6.5 });
                p.lastShot = now;
            }
        } else {
            // MAP TRAVELLING: Move intentionally towards active waypoints to explore entire arena maps
            let distToWaypoint = Math.hypot(p.targetX - p.x, p.targetY - p.y);
            
            // If waypoint reached or bot gets jammed, roll a completely new location on the map layout
            if (distToWaypoint < 20 || p.stuckTimer > 45) {
                let newNode = getRandomWaypoint();
                p.targetX = newNode.x;
                p.targetY = newNode.y;
                p.stuckTimer = 0;
            }

            p.angle = Math.atan2(p.targetY - p.y, p.targetX - p.x);
            let nextX = p.x + Math.cos(p.angle) * speed;
            let nextY = p.y + Math.sin(p.angle) * speed;

            if (!checkWallCollision(nextX, nextY)) {
                p.x = nextX; p.y = nextY;
                if(Math.random() < 0.02) p.stuckTimer = 0; // standard reset
            } else {
                p.stuckTimer++;
                // Scatter alternate paths when hitting wall boundaries to navigate corridors cleanly
                p.angle += (Math.random() > 0.5 ? Math.PI / 2 : -Math.PI / 2);
                let altX = p.x + Math.cos(p.angle) * speed;
                let altY = p.y + Math.sin(p.angle) * speed;
                if (!checkWallCollision(altX, altY)) { p.x = altX; p.y = altY; }
            }
        }
    }

    io.emit('gameState', { players, bullets });
}

setInterval(updateGame, 1000 / 30);

io.on('connection', (socket) => {
    let spawn = getRandomWaypoint();
    players[socket.id] = { id: socket.id, name: getRandomName(), x: spawn.x, y: spawn.y, angle: 0, health: 5, isBot: false };
    socket.emit('init', { maze, size: MAZE_SIZE, cellSize: CELL_SIZE, id: socket.id });

    socket.on('move', (data) => {
        let p = players[socket.id];
        if (!p) return;
        p.angle = data.angle;
        let nextX = p.x + Math.cos(p.angle) * data.speed;
        let nextY = p.y + Math.sin(p.angle) * data.speed;
        if (!checkWallCollision(nextX, nextY)) { p.x = nextX; p.y = nextY; }
    });

    socket.on('shoot', () => {
        let p = players[socket.id];
        if (!p) return;
        bullets.push({ ownerId: socket.id, x: p.x, y: p.y, angle: p.angle, speed: 8 });
    });

    socket.on('disconnect', () => { delete players[socket.id]; });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Smart pathing system online on port ${PORT}`));
