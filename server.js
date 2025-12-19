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
            const playerCount = Object.values(room.players).filter(p => !p.isHost && !p.isMC && !p.isViewer).length;
            list.push({ id: id, playerCount: playerCount });
        }
    }
    return list;
}

io.on('connection', (socket) => {
    socket.emit('roomListUpdate', getPublicRooms());
    socket.on('requestRoomList', () => socket.emit('roomListUpdate', getPublicRooms()));

    // --- JOIN ROOM ---
    socket.on('joinRoom', ({ roomId, playerName, isHost, isViewer, isMC }) => {
        if (!isHost && !rooms[roomId]) {
            socket.emit('errorMessage', `❌ Lỗi: Phòng '${roomId}' chưa tạo!`);
            return;
        }

        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = {
                hostId: null,
                roundType: 'VNCV', 
                
                // STATE VNCV
                vncv: {
                    question: "",
                    isInputOpen: false, // Quan trọng: False là khóa, True là mở
                    targetPlayerId: null, 
                },
                answerMode: 'hostLocked', 

                // STATE TANG TOC
                tangtoc: {
                    status: 'IDLE',
                    questionText: "",
                    questionData: "",
                    buzzedPlayer: null 
                },
                players: {}
            };
        }

        const room = rooms[roomId];
        room.players[socket.id] = {
            id: socket.id, name: playerName, isHost, isViewer, isMC, lastAnswer: "" 
        };

        if (isHost) room.hostId = socket.id;
        io.to(roomId).emit('updateState', room);
        io.emit('roomListUpdate', getPublicRooms());
    });

    // --- CHUYỂN VÒNG ---
    socket.on('switchRound', ({ roomId, type }) => {
        if (rooms[roomId]) {
            rooms[roomId].roundType = type;
            // Reset khi chuyển vòng
            if (type === 'TANGTOC') {
                rooms[roomId].tangtoc.status = 'IDLE';
                rooms[roomId].tangtoc.buzzedPlayer = null;
            } else {
                rooms[roomId].vncv.isInputOpen = false;
                rooms[roomId].answerMode = 'hostLocked';
                if(activeTimer) clearTimeout(activeTimer);
            }
            io.to(roomId).emit('updateState', rooms[roomId]);
        }
    });

    // --- LOGIC VNCV (FIX: Bấm giờ là Mở cổng) ---
    socket.on('updateVncvQuestion', ({ roomId, text }) => {
        if (rooms[roomId]) {
            rooms[roomId].vncv.question = text;
            io.to(roomId).emit('updateState', rooms[roomId]);
        }
    });

    socket.on('controlMedia', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;

        if (data.action === 'startTimer') {
            if (activeTimer) clearTimeout(activeTimer);
            
            const duration = data.duration; // 15 hoặc 30
            
            // 1. MỞ CỔNG NGAY LẬP TỨC
            room.vncv.isInputOpen = true; 
            room.answerMode = 'unlocked';

            // 2. GỬI LỆNH PHÁT NHẠC
            const audioFile = (duration === 15) ? 'timer15.mp3' : 'timer30.mp3';
            io.to(data.roomId).emit('mediaControl', { action: 'startTimer', duration: duration, audio: audioFile });
            
            // 3. CẬP NHẬT STATE ĐỂ CLIENT MỞ INPUT
            io.to(data.roomId).emit('updateState', room);

            // 4. ĐẾM NGƯỢC ĐỂ KHÓA
            activeTimer = setTimeout(() => {
                room.vncv.isInputOpen = false;
                room.answerMode = 'hostLocked';
                io.to(data.roomId).emit('updateState', room);
                io.to(data.roomId).emit('mediaControl', { action: 'timeUp' });
            }, duration * 1000);

        } else if (data.action === 'stop') {
            if (activeTimer) clearTimeout(activeTimer);
            room.vncv.isInputOpen = false;
            room.answerMode = 'hostLocked';
            io.to(data.roomId).emit('mediaControl', { action: 'stop' }); 
            io.to(data.roomId).emit('updateState', room);
        }
    });

    socket.on('submitAnswer', ({ roomId, answer }) => {
        const room = rooms[roomId];
        // Cho phép nhận nếu cổng mở hoặc được chỉ định
        if (room && (room.answerMode === 'unlocked' || room.vncv.targetPlayerId === socket.id)) {
            room.players[socket.id].lastAnswer = answer;
            io.to(roomId).emit('updateState', room);
        }
    });

    // --- LOGIC TĂNG TỐC ---
    socket.on('ttControl', ({ roomId, action, data }) => {
        const room = rooms[roomId];
        if (!room) return;
        if (action === 'start') {
            room.tangtoc.status = 'SHOW_QUESTION';
            room.tangtoc.questionText = data.text;
            room.tangtoc.questionData = data.media;
            room.tangtoc.buzzedPlayer = null;
        } else if (action === 'continue') {
            if (room.tangtoc.status === 'BUZZED') {
                room.tangtoc.status = 'SHOW_QUESTION';
                room.tangtoc.buzzedPlayer = null;
            }
        } else if (action === 'reset') {
            room.tangtoc.status = 'IDLE';
            room.tangtoc.questionText = "";
            room.tangtoc.questionData = "";
            room.tangtoc.buzzedPlayer = null;
        }
        io.to(roomId).emit('updateState', room);
    });

    socket.on('ttBuzz', ({ roomId }) => {
        const room = rooms[roomId];
        if (room && room.tangtoc.status === 'SHOW_QUESTION' && !room.tangtoc.buzzedPlayer) {
            const player = room.players[socket.id];
            if (player) {
                room.tangtoc.status = 'BUZZED';
                room.tangtoc.buzzedPlayer = { id: player.id, name: player.name };
                io.to(roomId).emit('updateState', room);
                io.to(roomId).emit('playSound', 'buzzer');
            }
        }
    });

    socket.on('disconnect', () => {
        for (const rId in rooms) {
            if (rooms[rId].players[socket.id]) {
                delete rooms[rId].players[socket.id];
                if (rooms[rId].hostId === socket.id) delete rooms[rId];
                else io.to(rId).emit('updateState', rooms[rId]);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server chạy port ${PORT}`));