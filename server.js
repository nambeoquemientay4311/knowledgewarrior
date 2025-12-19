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
let activeTimer = null; // Timer xử lý đếm ngược

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
    // Gửi danh sách phòng
    socket.emit('roomListUpdate', getPublicRooms());
    socket.on('requestRoomList', () => socket.emit('roomListUpdate', getPublicRooms()));

    // --- 1. XỬ LÝ VÀO PHÒNG ---
    socket.on('joinRoom', ({ roomId, playerName, isHost, isViewer, isMC }) => {
        // Nếu là Thí sinh mà phòng chưa tạo -> Báo lỗi
        if (!isHost && !rooms[roomId]) {
            socket.emit('errorMessage', `❌ Lỗi: Phòng '${roomId}' chưa được tạo. Vui lòng chờ Host!`);
            return;
        }

        socket.join(roomId);

        // Tạo phòng nếu là Host
        if (!rooms[roomId]) {
            rooms[roomId] = {
                hostId: null,
                vncv: {
                    question: "",
                    isInputOpen: false, // Trạng thái khóa/mở input
                    targetPlayerId: null, 
                },
                answerMode: 'hostLocked', 
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
            lastAnswer: "" // Lưu câu trả lời
        };

        if (isHost) room.hostId = socket.id;

        // Gửi thông báo cập nhật cho tất cả mọi người trong phòng
        io.to(roomId).emit('updateState', room);
        io.emit('roomListUpdate', getPublicRooms());
    });

    // --- 2. CẬP NHẬT CÂU HỎI ---
    socket.on('updateVncvQuestion', ({ roomId, text }) => {
        if (rooms[roomId]) {
            rooms[roomId].vncv.question = text;
            io.to(roomId).emit('updateState', rooms[roomId]);
        }
    });

    // --- 3. XỬ LÝ MEDIA & TIMER (QUAN TRỌNG: Bấm giờ là MỞ KHÓA) ---
    socket.on('controlMedia', (data) => {
        const room = rooms[data.roomId];
        if (!room) return;

        if (data.action === 'startTimer') {
            if (activeTimer) clearTimeout(activeTimer);
            const duration = data.duration;

            // Mở cổng trả lời
            room.vncv.isInputOpen = true; 
            room.answerMode = 'unlocked';

            // Gửi lệnh phát nhạc xuống Client
            const audioFile = (duration === 15) ? 'timer15.mp3' : 'timer30.mp3';
            io.to(data.roomId).emit('mediaControl', { action: 'startTimer', duration: duration, audio: audioFile });
            io.to(data.roomId).emit('updateState', room);

            // Đếm ngược trên server để tự động khóa
            activeTimer = setTimeout(() => {
                room.vncv.isInputOpen = false;
                room.answerMode = 'hostLocked';
                io.to(data.roomId).emit('updateState', room);
                io.to(data.roomId).emit('mediaControl', { action: 'timeUp' });
            }, duration * 1000);

        } else if (data.action === 'stop') {
            if (activeTimer) clearTimeout(activeTimer);
            // Dừng và khóa ngay lập tức
            room.vncv.isInputOpen = false;
            room.answerMode = 'hostLocked';
            io.to(data.roomId).emit('mediaControl', { action: 'stop' }); 
            io.to(data.roomId).emit('updateState', room);
        }
    });

    // --- 4. NHẬN CÂU TRẢ LỜI ---
    socket.on('submitAnswer', ({ roomId, answer }) => {
        const room = rooms[roomId];
        // Chỉ nhận khi cổng mở
        if (room && (room.answerMode === 'unlocked' || room.vncv.targetPlayerId === socket.id)) {
            room.players[socket.id].lastAnswer = answer;
            io.to(roomId).emit('updateState', room);
        }
    });

    // --- 5. NGẮT KẾT NỐI ---
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
server.listen(PORT, () => console.log(`Server đang chạy cổng ${PORT}`));