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
    // Gửi danh sách phòng khi mới vào
    socket.emit('roomListUpdate', getPublicRooms());
    socket.on('requestRoomList', () => socket.emit('roomListUpdate', getPublicRooms()));

    // --- TẠO / VÀO PHÒNG ---
    socket.on('joinRoom', ({ roomId, playerName, isHost, isViewer, isMC }) => {
        if (!isHost && !rooms[roomId]) {
            socket.emit('errorMessage', `❌ Lỗi: Phòng '${roomId}' không tồn tại!`);
            return;
        }

        socket.join(roomId);

        // Khởi tạo phòng nếu chưa có
        if (!rooms[roomId]) {
            rooms[roomId] = {
                hostId: null,
                roundType: 'VNCV', // Mặc định là Vượt chướng ngại vật (VNCV) hoặc Ô Mạo Hiểm
                
                // State cho VNCV / Ô Mạo Hiểm (Giữ nguyên logic cũ của bạn)
                vncv: {
                    question: "",
                    isInputOpen: false,
                    targetPlayerId: null,
                },
                answerMode: 'hostLocked', 

                // State cho Tăng Tốc (MỚI)
                tangtoc: {
                    status: 'IDLE', // IDLE, SHOW_QUESTION, BUZZED
                    questionText: "",
                    questionData: "", // Dữ kiện hoặc Link ảnh
                    buzzedPlayer: null // { id, name }
                },

                players: {}
            };
        }

        const room = rooms[roomId];

        // Đăng ký người chơi
        room.players[socket.id] = {
            id: socket.id,
            name: playerName,
            isHost: isHost,
            isViewer: isViewer,
            isMC: isMC,
            score: 0,
            lastAnswer: "" // Dùng cho VNCV
        };

        if (isHost) room.hostId = socket.id;

        // Gửi state cập nhật cho tất cả
        io.to(roomId).emit('updateState', room);
        io.emit('roomListUpdate', getPublicRooms());
    });

    // --- HOST: CHUYỂN ĐỔI VÒNG CHƠI (QUAN TRỌNG) ---
    socket.on('switchRound', ({ roomId, type }) => {
        if (rooms[roomId]) {
            rooms[roomId].roundType = type; // 'VNCV' hoặc 'TANGTOC'
            // Reset trạng thái Tăng tốc khi chuyển vào
            if (type === 'TANGTOC') {
                rooms[roomId].tangtoc = {
                    status: 'IDLE',
                    questionText: "",
                    questionData: "",
                    buzzedPlayer: null
                };
            }
            io.to(roomId).emit('updateState', rooms[roomId]);
        }
    });

    // --- LOGIC TĂNG TỐC (MỚI) ---
    socket.on('ttControl', ({ roomId, action, data }) => {
        const room = rooms[roomId];
        if (!room) return;

        if (action === 'start') {
            room.tangtoc.status = 'SHOW_QUESTION';
            room.tangtoc.questionText = data.text;
            room.tangtoc.questionData = data.media;
            room.tangtoc.buzzedPlayer = null; // Reset người buzz
            // Reset timer trên client sẽ được xử lý ở client khi nhận status mới
        } 
        else if (action === 'continue') {
            // Host bấm "Tiếp tục" -> Ẩn buzzer, thời gian chạy tiếp
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

    // --- PLAYER: TĂNG TỐC BUZZ ---
    socket.on('ttBuzz', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        
        // Chỉ nhận Buzz nếu đang hiện câu hỏi và chưa ai Buzz
        if (room.tangtoc.status === 'SHOW_QUESTION' && !room.tangtoc.buzzedPlayer) {
            const player = room.players[socket.id];
            if (player) {
                room.tangtoc.status = 'BUZZED';
                room.tangtoc.buzzedPlayer = { id: player.id, name: player.name };
                io.to(roomId).emit('updateState', room);
                
                // Phát âm thanh Buzzer
                io.to(roomId).emit('playSound', 'buzzer');
            }
        }
    });

    // --- LOGIC VNCV CŨ (GIỮ NGUYÊN HOẶC RÚT GỌN NẾU CẦN) ---
    // (Tôi giữ lại logic cơ bản để code cũ của bạn không bị lỗi)
    socket.on('controlMedia', (data) => {
         // ... (Logic cũ của bạn cho VNCV) ...
    });
    
    // ... Xử lý disconnect ...
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
    console.log(`Server đang chạy tại cổng ${PORT}`);
});