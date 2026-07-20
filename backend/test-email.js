// test-email.js — chạy độc lập để kiểm tra SMTP Gmail có gửi được không
// Cách chạy: node test-email.js
//
// Trước khi chạy, điền đúng 3 giá trị bên dưới (copy y hệt từ Render → Environment):
const SMTP_USER = 'ntphuoganh@gmail.com';
const SMTP_PASS = 'uopojwuyuismacgx';   // KHÔNG phải mật khẩu Gmail thường
const SEND_TO   = '22010079@st.phenikaa-uni.edu.vn'; // có thể để giống SMTP_USER

const nodemailer = require('nodemailer');

async function main() {
    console.log('Đang tạo transporter...');
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: SMTP_USER, pass: SMTP_PASS },
    });

    console.log('Đang xác thực (verify) với Gmail...');
    try {
        await transporter.verify();
        console.log('Xác thực SMTP THÀNH CÔNG — tài khoản/app password hợp lệ.');
    } catch (err) {
        console.error('Xác thực SMTP THẤT BẠI. Chi tiết lỗi:');
        console.error(err);
        console.error('\n→ Lỗi này thường do: dùng mật khẩu Gmail thường thay vì App Password,');
        console.error('  hoặc tài khoản Gmail chưa bật xác minh 2 bước (2FA) nên chưa có App Password.');
        return;
    }

    console.log('Đang gửi email thử...');
    try {
        const info = await transporter.sendMail({
            from: `"HSK Flashcard Test" <${SMTP_USER}>`,
            to: SEND_TO,
            subject: 'Test gửi email - HSK Flashcard',
            html: '<p>Nếu bạn nhận được email này, cấu hình SMTP đã hoạt động đúng.</p>',
        });
        console.log('Gửi thành công! messageId:', info.messageId);
        console.log('   Kiểm tra hộp thư (và cả mục Spam) của:', SEND_TO);
    } catch (err) {
        console.error('Gửi email THẤT BẠI. Chi tiết lỗi:');
        console.error(err);
    }
}

main();