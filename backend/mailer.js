// backend/mailer.js
// Gửi email quên mật khẩu qua Gmail SMTP (dùng App Password, KHÔNG dùng mật khẩu Gmail thật).
// Cách lấy App Password: xem hướng dẫn Claude đã đưa kèm phần .env.
const nodemailer = require('nodemailer');

let transporter = null;
function getTransporter() {
    if (transporter) return transporter;
    transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
    });
    return transporter;
}

async function sendResetPasswordEmail(toEmail, resetLink) {
    const tx = getTransporter();
    await tx.sendMail({
        from: `"HSK Flashcard 汉字学园" <${process.env.SMTP_USER}>`,
        to: toEmail,
        subject: 'Đặt lại mật khẩu - HSK Flashcard',
        html: `
            <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
                <h2 style="color:#4f46e5">汉字学园 · HSK Flashcard</h2>
                <p>Bạn (hoặc ai đó) vừa yêu cầu đặt lại mật khẩu cho tài khoản này.</p>
                <p>Nhấn vào nút bên dưới để đặt mật khẩu mới. Liên kết có hiệu lực trong <b>30 phút</b>.</p>
                <p style="text-align:center;margin:24px 0">
                    <a href="${resetLink}" style="background:#4f46e5;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block">Đặt lại mật khẩu</a>
                </p>
                <p style="color:#666;font-size:13px">Nếu bạn không yêu cầu, hãy bỏ qua email này — mật khẩu của bạn sẽ không thay đổi.</p>
                <p style="color:#999;font-size:12px">Nếu nút không hoạt động, sao chép liên kết sau vào trình duyệt:<br>${resetLink}</p>
            </div>
        `,
    });
}

module.exports = { sendResetPasswordEmail };