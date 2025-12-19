const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
let activeTimer = null; 

function getPublicRooms() {
    const list = [];
    for (const [id, room] of Object.entries(rooms)) {
        if (room.hostId) { 
            const playerCount = Object.values(room.players).filter(p => !p.isHost && !p.isMC).length;
            list.push({ id: id, playerCount: playerCount });
        }
    }
    return list;
}

io.on('connection', (socket) => {
    socket.emit('roomListUpdate', getPublicRooms());
    socket.on('requestRoomList', () => socket.emit('roomListUpdate', getPublicRooms()));

    // JOIN ROOM
    socket.on('joinRoom', ({ roomId, playerName, isHost, isViewer, isMC }) => {
        if ((!isHost) && !rooms[roomId]) {
            socket.emit('errorMessage', `❌ Lỗi: Phòng '${roomId}' không tồn tại!`);
            return;
        }

        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: {},
                hostId: null,
                answerMode: 'hostLocked', 
                vncv: { question: null, correctAnswer: null, wagerPoints: 0, isInputOpen: false, targetPlayerId: null } 
            };
        }
        const room = rooms[roomId];

        if (isViewer || isMC) {
            socket.emit('updateState', room);
            const role = isViewer ? 'viewer' : 'mc';
            socket.emit('joinSuccess', { role: role, roomId });
            return;
        }

        if (!isHost) {
            const names = Object.values(room.players).filter(p => !p.isHost && !p.isMC).map(p => p.name.toLowerCase());
            if (names.includes(playerName.toLowerCase())) {
                 socket.emit('errorMessage', '❌ Tên đã tồn tại!');
                 socket.leave(roomId); 
                 return;
            }
        }
        
        room.players[socket.id] = {
            id: socket.id,
            name: playerName,
            isHost: isHost,
            isMC: isMC || false,
            lastAnswer: null,
            hasSubmitted: false
        };

        if (isHost) {
            room.hostId = socket.id;
            io.emit('roomListUpdate', getPublicRooms()); 
        }

        io.to(roomId).emit('updateState', room);
        socket.emit('joinSuccess', { role: isHost ? 'host' : 'player', roomId });
    });

    // SUBMIT ANSWER (LUÔN VIẾT HOA)
    socket.on('submitAnswer', ({ roomId, answer }) => {
        const room = rooms[roomId];
        if (!room || !room.players[socket.id]) return;
        
        const playerId = socket.id;
        const vncv = room.vncv || {};
        let isInputAllowed = false;

        if (vncv.targetPlayerId) {
            if (vncv.targetPlayerId === playerId && vncv.isInputOpen) isInputAllowed = true;
        } else {
            if (room.answerMode === 'unlocked') isInputAllowed = true;
        }

        if (isInputAllowed) {
            const upperAnswer = answer ? answer.toString().toUpperCase() : "";
            room.players[playerId].lastAnswer = upperAnswer;
            room.players[playerId].hasSubmitted = true; 
            io.to(roomId).emit('updateState', room);
        }
    });

    // HOST CONTROL
    socket.on('hostControl', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;
        
        if (data.action === 'clearBuzzers') {
            Object.keys(room.players).forEach(pid => {
                room.players[pid].lastAnswer = null;
                room.players[pid].hasSubmitted = false;
            });
            if(room.vncv) {
                room.vncv.targetPlayerId = null; 
                room.vncv.isInputOpen = false;
                room.vncv.wagerPoints = 0; 
            }
            room.answerMode = 'hostLocked';
            if(activeTimer) clearTimeout(activeTimer);
            io.to(data.roomId).emit('mediaControl', { action: 'stop' });

        } else if (data.action === 'setAnswerMode') {
            room.answerMode = data.value;
            if(room.vncv) {
                if (data.value === 'unlocked') room.vncv.isInputOpen = true; 
                else if (data.value === 'hostLocked') room.vncv.isInputOpen = false;
            }
        }
        io.to(data.roomId).emit('updateState', room);
    });

    // ADMIN
    socket.on('adminVNCV', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;
        
        if (data.action === 'storeQuestion') { 
            if(!room.vncv) room.vncv = {};
            room.vncv.question = data.question; 
            room.vncv.correctAnswer = data.correctAnswer;
        } else if (data.action === 'selectPlayer') { 
            const targetId = data.playerId;
            if (room.players[targetId]) {
                room.vncv.targetPlayerId = targetId; 
                room.vncv.isInputOpen = false; 
                room.players[targetId].lastAnswer = null; 
                room.players[targetId].hasSubmitted = false;
                room.answerMode = 'hostLocked'; 
            }
        } else if (data.action === 'setWager') {
            if(!room.vncv) room.vncv = {};
            room.vncv.wagerPoints = data.points;
        }
        io.to(data.roomId).emit('updateState', room);
    });

    socket.on('hostPrivateChat', ({ roomId, targetId, message }) => {
        io.to(targetId).emit('privateMessage', { message: message });
    });

    // MEDIA
    socket.on('controlMedia', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;
        
        if (data.action === 'playSfx') {
            io.to(data.roomId).emit('mediaControl', { action: 'playSfx', type: data.type });
            return;
        }

        if (activeTimer) clearTimeout(activeTimer);

        if (data.action === 'playAudio') {
            io.to(data.roomId).emit('mediaControl', { action: 'playAudio', file: data.file });
        } else if (data.action === 'startGeneralTimer') {
            room.vncv.targetPlayerId = null;
            room.answerMode = 'unlocked';    
            io.to(data.roomId).emit('mediaControl', { action: 'startTimer', duration: 15, audio: 'betting' });
            io.to(data.roomId).emit('updateState', room);
            activeTimer = setTimeout(() => {
                room.answerMode = 'hostLocked'; 
                io.to(data.roomId).emit('updateState', room);
                io.to(data.roomId).emit('mediaControl', { action: 'timeUp' });
            }, 15000);

        // --- SỬA ĐỔI TẠI ĐÂY: START TARGET TIMER ---
        } else if (data.action === 'startTargetTimer') {
            const targetId = room.vncv.targetPlayerId;
            if (!targetId) return;
            
            // --- RESET ĐÁP ÁN CŨ ---
            if (room.players[targetId]) {
                room.players[targetId].lastAnswer = null; // Xóa đáp án
                room.players[targetId].hasSubmitted = false; // Reset trạng thái
            }
            // -----------------------

            room.vncv.isInputOpen = true; 
            room.answerMode = 'hostLocked'; 
            const duration = data.duration;
            const audioFile = (duration === 15) ? 'timer15' : 'timer30';
            
            io.to(data.roomId).emit('mediaControl', { action: 'startTimer', duration: duration, audio: audioFile });
            io.to(data.roomId).emit('updateState', room); // Cập nhật ngay để xóa chữ trên màn hình
            
            activeTimer = setTimeout(() => {
                room.vncv.isInputOpen = false; 
                io.to(data.roomId).emit('updateState', room);
                io.to(data.roomId).emit('mediaControl', { action: 'timeUp' });
            }, duration * 1000);

        } else if (data.action === 'stop') {
            room.vncv.isInputOpen = false;
            room.answerMode = 'hostLocked';
            io.to(data.roomId).emit('mediaControl', { action: 'stop' }); 
            io.to(data.roomId).emit('updateState', room);
        }
    });

    socket.on('disconnect', () => {
        let hasChange = false;
        for (const rId in rooms) {
            const room = rooms[rId];
            if (room.players[socket.id]) {
                delete room.players[socket.id];
                if (room.hostId === socket.id) { delete rooms[rId]; hasChange = true; }
                else { io.to(rId).emit('updateState', room); }
                hasChange = true;
            }
        }
        if(hasChange) io.emit('roomListUpdate', getPublicRooms());
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server chạy tại port ${PORT}`));