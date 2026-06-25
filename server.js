const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// --- GAME CONFIG & STATE ---
const MAZE_SIZE = 15; 
const CELL_SIZE = 100; 
const MAP_SIZE = MAZE_SIZE * CELL_SIZE; 
let players = {};
let bullets = [];
let gameLoopInterval = null;

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

const namesList = ["Ghost", "Shadow", "Viper", "Phoenix", "Titan", "Specter", "Reaper", "Alpha", "Omega", "Hunter", "Rogue", "Blaze", "Frost", "Wolf", "Ninja", "Slayer"];
function getRandomName() {
    return namesList[Math.floor(Math.random() * namesList.length)] + "#" + Math.floor(1000 + Math.random() * 9000);
}

function getValidSpawnPos() {
    return {
        x: Math.random() * (MAP_SIZE - 60) + 30,
        y: Math.random() * (MAP_SIZE - 60) + 30
    };
}

// 25 Bots Total (20 Medium, 5 Very Tough)
function initBots() {
    for (let i = 0; i < 25; i++) {
        const isHard = i >= 20; // Last 5 bots are tough
        const botId = `bot_${i}_${Date.now()}`;
        const spawn = getValidSpawnPos();
        players[botId] = {
            id: botId,
            name: isHard ? `💀 ULTRA_${getRandomName()}` : `🤖 ${getRandomName()}`,
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

function updateGame() {
    // Update Bullets
    for (let i = bullets.length - 1; i >= 0; i--) {
        let b = bullets[i];
        b.x += Math.cos(b.angle) * b.speed;
        b.y += Math.sin(b.angle) * b.speed;

        if (checkWallCollision(b.x, b.y, 4) || b.x < 0 || b.x > MAP_SIZE || b.y < 0 || b.y > MAP_SIZE) {
            bullets.splice(i, 1);
            continue;
        }

        for (let pId in players) {
            let p = players[pId];
            if (pId !== b.ownerId) {
                let dist = Math.hypot(p.x - b.x, p.y - b.y);
                if (dist < 18) {
                    p.health -= 1;
                    bullets.splice(i, 1);
                    if (p.health <= 0) { delete players[pId]; }
                    break;
                }
            }
        }
    }

    // Process Bot Movement & Shooting Loop
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

        // Config variables between Medium and Ultra bots
        let speed = p.isHard ? 3.8 : 2.0; 
        let detectionRange = p.isHard ? 600 : 300;
        let fireCooldown = p.isHard ? 350 : 1200;

        if (closestTarget && minDist < detectionRange) {
            p.angle = Math.atan2(closestTarget.y - p.y, closestTarget.x - p.x);
            
            let nextX = p.x + Math.cos(p.angle) * speed;
            let nextY = p.y + Math.sin(p.angle) * speed;
            if (!checkWallCollision(nextX, nextY)) { p.x = nextX; p.y = nextY; }

            if (now - p.lastShot > fireCooldown) {
                bullets.push({ ownerId: id, x: p.x, y: p.y, angle: p.angle, speed: p.isHard ? 9 : 6.5 });
                p.lastShot = now;
            }
        } else {
            if (Math.random() < 0.04) p.angle += (Math.random() - 0.5) * 2.5;
            let nextX = p.x + Math.cos(p.angle) * speed;
            let nextY = p.y + Math.sin(p.angle) * speed;
            if (!checkWallCollision(nextX, nextY)) { p.x = nextX; p.y = nextY; }
        }
    }

    io.emit('gameState', { players, bullets });
}

if (!gameLoopInterval) gameLoopInterval = setInterval(updateGame, 1000 / 60);

io.on('connection', (socket) => {
    const spawn = getValidSpawnPos();
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
        bullets.push({ ownerId: socket.id, x: p.x, y: p.y, angle: p.angle, speed: 8.5 });
    });

    socket.on('disconnect', () => { delete players[socket.id]; });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Game running on port ${PORT}`));
