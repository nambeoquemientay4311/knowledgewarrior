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
let activeTimer = null; // Timer dùng cho VNCV (server đếm ngược để khóa input)

// Hàm lấy danh sách phòng hiển thị ra ngoài
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
    // 1. Gửi danh sách phòng khi kết nối
    socket.emit('roomListUpdate', getPublicRooms());
    socket.on('requestRoomList', () => socket.emit('roomListUpdate', getPublicRooms()));

    // 2. Xử lý tạo/vào phòng
    socket.on('joinRoom', ({ roomId, playerName, isHost, isViewer, isMC }) => {
        // Nếu không phải Host mà phòng chưa tạo -> Báo lỗi
        if (!isHost && !rooms[roomId]) {
            socket.emit('errorMessage', `❌ Phòng '${roomId}' chưa được tạo!`);
            return;
        }

        socket.join(roomId);

        // Nếu phòng chưa có -> Tạo mới (Dành cho Host)
        if (!rooms[roomId]) {
            rooms[roomId] = {
                hostId: null,
                roundType: 'VNCV', // Mặc định vào là vòng Ô Mạo Hiểm
                
                // STATE RIÊNG CHO VNCV
                vncv: {
                    question: "",
                    isInputOpen: false, // Cờ kiểm soát mở/khóa input
                    targetPlayerId: null, // Dành cho vòng Về đích (nếu cần), hiện tại để null
                },
                answerMode: 'hostLocked', 

                // STATE RIÊNG CHO TĂNG TỐC
                tangtoc: {
                    status: 'IDLE', // 'IDLE', 'SHOW_QUESTION', 'BUZZED'
                    questionText: "",
                    questionData: "",
                    buzzedPlayer: null 
                },

                players: {}
            };
        }

        const room = rooms[roomId];

        // Lưu thông tin người kết nối
        room.players[socket.id] = {
            id: socket.id,
            name: playerName,
            isHost: isHost,
            isViewer: isViewer,
            isMC: isMC,
            lastAnswer: "" // Lưu câu trả lời của VNCV
        };

        if (isHost) room.hostId = socket.id;

        // Cập nhật state cho toàn phòng
        io.to(roomId).emit('updateState', room);
        io.emit('roomListUpdate', getPublicRooms());
    });

    // 3. Xử lý Chuyển Vòng (Quan trọng: Reset state để tránh lỗi hiển thị)
    socket.on('switchRound', ({ roomId, type }) => {
        if (rooms[roomId]) {
            rooms[roomId].roundType = type; // 'VNCV' hoặc 'TANGTOC'
            
            // Reset dữ liệu khi chuyển
            if (type === 'TANGTOC') {
                rooms[roomId].tangtoc.status = 'IDLE';
                rooms[roomId].tangtoc.buzzedPlayer = null;
            } else {
                rooms[roomId].vncv.isInputOpen = false;
                rooms[roomId].answerMode = 'hostLocked';
                if(activeTimer) clearTimeout(activeTimer); // Hủy timer cũ nếu có
            }
            io.to(roomId).emit('updateState', rooms[roomId]);
        }
    });

    // --- LOGIC VÒNG: Ô MẠO HIỂM (VNCV) ---
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
            const duration = data.duration; // 15s hoặc 30s
            
            // MỞ CỔNG TRẢ LỜI
            room.vncv.isInputOpen = true; 
            room.answerMode = 'unlocked';

            // Gửi lệnh xuống client (để chạy nhạc, hiện đếm ngược)
            const audioFile = (duration === 15) ? 'timer15.mp3' : 'timer30.mp3';
            io.to(data.roomId).emit('mediaControl', { action: 'startTimer', duration: duration, audio: audioFile });
            io.to(data.roomId).emit('updateState', room);

            // Server tự đếm ngược để khóa cổng
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
        // Chỉ nhận đáp án khi cổng đang mở
        if (room && (room.answerMode === 'unlocked' || room.vncv.targetPlayerId === socket.id)) {
            room.players[socket.id].lastAnswer = answer;
            io.to(roomId).emit('updateState', room);
        }
    });

    // --- LOGIC VÒNG: TĂNG TỐC ---
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
            // Nếu đang Buzz mà bấm tiếp tục -> Quay lại hiện câu hỏi, ẩn buzz, chạy tiếp giờ
            if (room.tangtoc.status === 'BUZZED') {
                room.tangtoc.status = 'SHOW_QUESTION';
                room.tangtoc.buzzedPlayer = null;
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
        // Chỉ nhận Buzz khi đang hiện câu hỏi
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

    // 4. Ngắt kết nối
    socket.on('disconnect', () => {
        for (const rId in rooms) {
            if (rooms[rId].players[socket.id]) {
                delete rooms[rId].players[socket.id];
                if (rooms[rId].hostId === socket.id) delete rooms[rId]; // Xóa phòng nếu host thoát
                else io.to(rId).emit('updateState', rooms[rId]);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});