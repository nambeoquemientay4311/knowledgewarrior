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
let activeTimer = null; // Biến lưu timer của server

// Hàm lấy danh sách phòng
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
    // Gửi list phòng
    socket.emit('roomListUpdate', getPublicRooms());
    socket.on('requestRoomList', () => socket.emit('roomListUpdate', getPublicRooms()));

    // --- JOIN ROOM ---
    socket.on('joinRoom', ({ roomId, playerName, isHost, isViewer, isMC }) => {
        if (!isHost && !rooms[roomId]) {
            socket.emit('errorMessage', `❌ Lỗi: Phòng '${roomId}' không tồn tại!`);
            return;
        }

        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = {
                hostId: null,
                roundType: 'VNCV', // Mặc định vào là Ô Mạo Hiểm
                
                // STATE Ô MẠO HIỂM (CŨ - ĐÃ KHÔI PHỤC)
                vncv: {
                    question: "",
                    isInputOpen: false, // Mở/đóng input trả lời
                    targetPlayerId: null,
                },
                answerMode: 'hostLocked', 

                // STATE TĂNG TỐC (MỚI)
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
            id: socket.id,
            name: playerName,
            isHost: isHost,
            isViewer: isViewer,
            isMC: isMC,
            score: 0,
            lastAnswer: "" // Dùng lưu đáp án Ô Mạo Hiểm
        };

        if (isHost) room.hostId = socket.id;

        io.to(roomId).emit('updateState', room);
        io.emit('roomListUpdate', getPublicRooms());
    });

    // --- CHUYỂN VÒNG (DÙNG CHUNG) ---
    socket.on('switchRound', ({ roomId, type }) => {
        if (rooms[roomId]) {
            rooms[roomId].roundType = type; // 'VNCV' hoặc 'TANGTOC'
            
            // Reset trạng thái khi chuyển để tránh lỗi hiển thị
            if(type === 'TANGTOC') {
                rooms[roomId].tangtoc.status = 'IDLE';
                rooms[roomId].tangtoc.buzzedPlayer = null;
            } else {
                rooms[roomId].vncv.isInputOpen = false;
                if(activeTimer) clearTimeout(activeTimer);
            }

            io.to(roomId).emit('updateState', rooms[roomId]);
        }
    });

    // ===============================================================
    // 1. LOGIC Ô MẠO HIỂM (CŨ - RESTORED)
    // ===============================================================
    
    // Xử lý Timer và Media (15s / 30s)
    socket.on('controlMedia', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;

        if (data.action === 'startTimer') {
            if (activeTimer) clearTimeout(activeTimer);

            const duration = data.duration; // 15 hoặc 30
            room.vncv.isInputOpen = true; // Mở input cho thí sinh
            
            // Gửi lệnh play nhạc/video xuống Client
            const audioFile = (duration === 15) ? 'timer15.mp3' : 'timer30.mp3'; 
            io.to(data.roomId).emit('mediaControl', { action: 'startTimer', duration: duration, audio: audioFile });
            io.to(data.roomId).emit('updateState', room);

            // Đếm ngược trên Server để tự đóng input
            activeTimer = setTimeout(() => {
                room.vncv.isInputOpen = false;
                io.to(data.roomId).emit('updateState', room);
                io.to(data.roomId).emit('mediaControl', { action: 'timeUp' });
            }, duration * 1000);

        } else if (data.action === 'stop') {
            if (activeTimer) clearTimeout(activeTimer);
            room.vncv.isInputOpen = false;
            io.to(data.roomId).emit('mediaControl', { action: 'stop' }); 
            io.to(data.roomId).emit('updateState', room);
        }
    });

    // Xử lý nộp đáp án (Chỉ cho Ô Mạo Hiểm)
    socket.on('submitAnswer', ({ roomId, answer }) => {
        const room = rooms[roomId];
        // Chỉ nhận nếu đang mở input
        if (room && room.vncv.isInputOpen) {
            room.players[socket.id].lastAnswer = answer;
            io.to(roomId).emit('updateState', room);
        }
    });

    // Host cập nhật câu hỏi VNCV
    socket.on('updateVncvQuestion', ({ roomId, text }) => {
        if(rooms[roomId]) {
            rooms[roomId].vncv.question = text;
            io.to(roomId).emit('updateState', rooms[roomId]);
        }
    });

    // ===============================================================
    // 2. LOGIC TĂNG TỐC (MỚI)
    // ===============================================================
    socket.on('ttControl', ({ roomId, action, data }) => {
        const room = rooms[roomId];
        if (!room) return;

        if (action === 'start') {
            room.tangtoc.status = 'SHOW_QUESTION';
            room.tangtoc.questionText = data.text;
            room.tangtoc.questionData = data.media;
            room.tangtoc.buzzedPlayer = null;
        } 
        else if (action === 'continue') {
            if (room.tangtoc.status === 'BUZZED') {
                room.tangtoc.status = 'SHOW_QUESTION'; // Quay lại hiện câu hỏi
                room.tangtoc.buzzedPlayer = null;      // Ẩn khung tên
            }
        } 
        else if (action === 'reset') {
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

    // --- DISCONNECT ---
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
server.listen(PORT, () => {
    console.log(`Server đang chạy tại cổng ${PORT}`);
});