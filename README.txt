TUAN FF ONLINE - GAME + ADMIN + TAI KHOAN

CAC FILE CAN DEPLOY LEN GITHUB (NAM CUNG THU MUC GOC):
- index.html: trang game, dang ky/dang nhap nguoi choi.
- admin.html: bang quan tri rieng. Sau khi deploy, mo: https://TEN-SERVICE.onrender.com/admin.html
- server.js: Socket.IO server va xu ly tai khoan/quyen admin.
- package.json: cau hinh npm.

CAU HINH RENDER:
1. Tao Web Service tu GitHub repository.
2. Build Command: npm install
3. Start Command: npm start
4. Environment variables:
   ADMIN_PASSWORD = mat khau admin tu dat
   DATABASE_URL = Internal Database URL cua PostgreSQL tren Render (can de tai khoan ton tai sau restart)

LUU Y:
- Neu khong cau hinh DATABASE_URL, tai khoan chi duoc luu trong bo nho va se mat khi server restart.
- Danh sach ban hien tai nam trong bo nho server, co the mat khi restart.
- Admin page dung cung Socket.IO server va xac thuc bang ADMIN_PASSWORD tren server.
- Khong dua mat khau ADMIN_PASSWORD vao index.html hay chia se cho nguoi choi.
