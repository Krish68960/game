// Run: npm install express socket.io
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const path = require('path');

// Replace your old app.use(express.static('public')) line with these two:
app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- GAME CONFIG & STATE ---
const MAZE_SIZE = 15; // 15x15 grid of cells
const CELL_SIZE = 100; // Each maze cell is 100x100 pixels
const MAP_SIZE = MAZE_SIZE * CELL_SIZE; // 1500x1500px total arena
let players = {};
let bullets = [];
let gameLoopInterval = null;

// Generate a random perfect maze using DFS (Depth-First Search)
function generateMaze(size) {
    let grid = Array(size).fill(null).map(() => Array(size).fill(null).map(() => ({ n: true, s: true, e: true, w: true })));
    let visited = Array(size).fill(null).map(() => Array(size).fill(false));
    let stack = [];
    
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

const namesList = ["Ghost", "Shadow", "Viper", "Phoenix", "Titan", "Specter", "Reaper", "猎人", "Alpha", "Omega", "Hunter", "Rogue", "Blaze", "Frost", "Wolf"];
function getRandomName() {
    return namesList[Math.floor(Math.random() * namesList.length)] + "#" + Math.floor(1000 + Math.random() * 9000);
}

// Generate a valid spawn position not intersecting any walls
function getValidSpawnPos() {
    return {
        x: Math.random() * (MAP_SIZE - 40) + 20,
        y: Math.random() * (MAP_SIZE - 40) + 20
    };
}

// Add the 25 Easy Bots and 2 Super Hard Bots
function initBots() {
    // 28 Bots Total (26 Easy, 2 Super Hard)
    for (let i = 0; i < 28; i++) {
        const isHard = i >= 26;
        const botId = `bot_${i}_${Date.now()}`;
        const spawn = getValidSpawnPos();
        players[botId] = {
            id: botId,
            name: isHard ? `🤖 ULTRA_${getRandomName()}` : `🤖 ${getRandomName()}`,
            x: spawn.x,
            y: spawn.y,
            angle: Math.random() * Math.PI * 2,
            health: 5,
            isBot: true,
            isHard: isHard,
            lastShot: 0
        };
    }
}
initBots();

// --- COLLISION LOGIC ---
function checkWallCollision(x, y, radius = 15) {
    let cellX = Math.floor(x / CELL_SIZE);
    let cellY = Math.floor(y / CELL_SIZE);
    
    if (cellX < 0 || cellX >= MAZE_SIZE || cellY < 0 || cellY >= MAZE_SIZE) return true;
    let cell = maze[cellY][cellX];
    
    let left = cellX * CELL_SIZE, right = left + CELL_SIZE;
    let top = cellY * CELL_SIZE, bottom = top + CELL_SIZE;

    if (cell.w && x - radius < left) return true;
    if (cell.e && x + radius > right) return true;
    if (cell.n && y - radius < top) return true;
    if (cell.s && y + radius > bottom) return true;
    return false;
}

// --- MAIN GAME MECHANICS LOOP ---
function updateGame() {
    // Update Bullets
    for (let i = bullets.length - 1; i >= 0; i--) {
        let b = bullets[i];
        b.x += Math.cos(b.angle) * b.speed;
        b.y += Math.sin(b.angle) * b.speed;

        // Check Wall Hit
        if (checkWallCollision(b.x, b.y, 4) || b.x < 0 || b.x > MAP_SIZE || b.y < 0 || b.y > MAP_SIZE) {
            bullets.splice(i, 1);
            continue;
        }

        // Check Player Hit
        for (let pId in players) {
            let p = players[pId];
            if (pId !== b.ownerId) {
                let dist = Math.hypot(p.x - b.x, p.y - b.y);
                if (dist < 18) { // Hit radius
                    p.health -= 1;
                    bullets.splice(i, 1);
                    
                    if (p.health <= 0) {
                        io.emit('playerKilled', { victim: p.name, killer: players[b.ownerId]?.name || "Environment" });
                        delete players[pId];
                    }
                    break;
                }
            }
        }
    }

    // Process Bot AI Decisions
    let now = Date.now();
    for (let id in players) {
        let p = players[id];
        if (!p.isBot) continue;

        // Find closest target
        let closestTarget = null;
        let minDist = Infinity;
        for (let tId in players) {
            if (tId !== id) {
                let dist = Math.hypot(players[tId].x - p.x, players[tId].y - p.y);
                if (dist < minDist) { minDist = dist; closestTarget = players[tId]; }
            }
        }

        let speed = p.isHard ? 3.5 : 1.5; // Super hard bots move significantly faster

        if (closestTarget && (p.isHard || minDist < 350)) {
            // Track & Look at Target
            let targetAngle = Math.atan2(closestTarget.y - p.y, closestTarget.x - p.x);
            p.angle = targetAngle;

            // Move closer
            let nextX = p.x + Math.cos(p.angle) * speed;
            let nextY = p.y + Math.sin(p.angle) * speed;
            if (!checkWallCollision(nextX, nextY)) { p.x = nextX; p.y = nextY; }

            // Fire mechanism based on difficulty
            let fireCooldown = p.isHard ? 400 : 1500; // Hard bots are lethal fire-rates
            if (now - p.lastShot > fireCooldown) {
                bullets.push({ ownerId: id, x: p.x, y: p.y, angle: p.angle, speed: 7 });
                p.lastShot = now;
            }
        } else {
            // Wander randomly if no player nearby
            if (Math.random() < 0.05) p.angle += (Math.random() - 0.5) * 2;
            let nextX = p.x + Math.cos(p.angle) * speed;
            let nextY = p.y + Math.sin(p.angle) * speed;
            if (!checkWallCollision(nextX, nextY)) { p.x = nextX; p.y = nextY; }
        }
    }

    // Broadcast updated map states
    io.emit('gameState', { players, bullets });
}

if (!gameLoopInterval) gameLoopInterval = setInterval(updateGame, 1000 / 60);

// --- SOCKET CONNECTIONS ---
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);
    const spawn = getValidSpawnPos();

    players[socket.id] = {
        id: socket.id,
        name: getRandomName(),
        x: spawn.x,
        y: spawn.y,
        angle: 0,
        health: 5,
        isBot: false
    };

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

    socket.on('disconnect', () => {
        delete players[socket.id];
        console.log(`User disconnected: ${socket.id}`);
    });
});

server.listen(3000, () => console.log('Game Server running on port 3000'));
