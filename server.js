const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

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

const namesList = ["Ghost", "Shadow", "Viper", "Phoenix", "Titan", "Specter", "Reaper", "Alpha", "Omega", "Hunter", "Rogue", "Blaze", "Frost", "Wolf", "Ninja", "Slayer"];
function getRandomName(prefix = "") {
    return prefix + namesList[Math.floor(Math.random() * namesList.length)] + "#" + Math.floor(1000 + Math.random() * 9000);
}

function getValidSpawnPos() {
    return { x: Math.random() * (MAP_SIZE - 60) + 30, y: Math.random() * (MAP_SIZE - 60) + 30 };
}

function initBots() {
    for (let i = 0; i < 25; i++) {
        const isHard = i >= 20; 
        const botId = `bot_${i}_${Date.now()}`;
        const spawn = getValidSpawnPos();
        players[botId] = {
            id: botId,
            name: getRandomName(isHard ? "ULTRA_" : ""),
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
    if (cell.w && x - radius < cellX * CELL_SIZE) return true;
    if (cell.e && x + radius > (cellX + 1) * CELL_SIZE) return true;
    if (cell.n && y - radius < cellY * CELL_SIZE) return true;
    if (cell.s && y + radius > (cellY + 1) * CELL_SIZE) return true;
    return false;
}

function updateGame() {
    // Bullets Physics
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
                if (Math.hypot(p.x - b.x, p.y - b.y) < 18) {
                    p.health -= 1;
                    bullets.splice(i, 1);
                    if (p.health <= 0) { delete players[pId]; }
                    break;
                }
            }
        }
    }

    // AUTOPILOT AI FOR EVERYONE (Bots & Human Viewers)
    let now = Date.now();
    for (let id in players) {
        let p = players[id];

        let closestTarget = null;
        let minDist = Infinity;
        for (let tId in players) {
            if (tId !== id) {
                let dist = Math.hypot(players[tId].x - p.x, players[tId].y - p.y);
                if (dist < minDist) { minDist = dist; closestTarget = players[tId]; }
            }
        }

        // Stats: Ultra Bots (Hard), Human Players (Medium), Normal Bots (Easy)
        let speed = p.isHard ? 3.5 : (!p.isBot ? 2.5 : 1.8); 
        let detectionRange = p.isHard ? 500 : (!p.isBot ? 350 : 250);
        let fireCooldown = p.isHard ? 400 : (!p.isBot ? 800 : 1300);

        if (closestTarget && minDist < detectionRange) {
            p.angle = Math.atan2(closestTarget.y - p.y, closestTarget.x - p.x);
            let nextX = p.x + Math.cos(p.angle) * speed;
            let nextY = p.y + Math.sin(p.angle) * speed;
            if (!checkWallCollision(nextX, nextY)) { p.x = nextX; p.y = nextY; }

            if (now - p.lastShot > fireCooldown) {
                bullets.push({ ownerId: id, x: p.x, y: p.y, angle: p.angle, speed: p.isHard ? 8.5 : (!p.isBot ? 7.5 : 6) });
                p.lastShot = now;
            }
        } else {
            if (Math.random() < 0.03) p.angle += (Math.random() - 0.5) * 2;
            let nextX = p.x + Math.cos(p.angle) * speed;
            let nextY = p.y + Math.sin(p.angle) * speed;
            if (!checkWallCollision(nextX, nextY)) { p.x = nextX; p.y = nextY; }
        }
    }

    io.emit('gameState', { players, bullets });
}

setInterval(updateGame, 1000 / 30);

io.on('connection', (socket) => {
    const spawn = getValidSpawnPos();
    // Human connects, gets assigned a unit, but server controls it
    players[socket.id] = { id: socket.id, name: getRandomName(), x: spawn.x, y: spawn.y, angle: 0, health: 5, isBot: false, lastShot: 0 };
    socket.emit('init', { maze, size: MAZE_SIZE, cellSize: CELL_SIZE, id: socket.id });

    socket.on('disconnect', () => { delete players[socket.id]; });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Auto-Battler server running on port ${PORT}`));
