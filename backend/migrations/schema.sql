-- ════════════════════════════════════════════════════════════════
--  HSK Flashcard — DB Schema (SRS/FSRS + Analytics + AI Cache)
--
--  LƯU Ý: server.js đã tự động tạo/cập nhật các bảng và cột dưới đây
--  mỗi khi khởi động (xem hàm ensureSchema() trong backend/server.js).
--  File này chỉ dùng để tham khảo hoặc setup thủ công một DB mới:
--    mysql -u root -p hsk_flashcard < backend/migrations/schema.sql
-- ════════════════════════════════════════════════════════════════

-- 1) TIẾN TRÌNH ÔN TẬP (SM-2 + FSRS-4.5), mỗi user x mỗi từ 1 dòng trạng thái
CREATE TABLE IF NOT EXISTS word_progress (
    id                INT AUTO_INCREMENT PRIMARY KEY,
    user_id           INT NOT NULL,
    word_id           INT NOT NULL,
    repetitions       INT NOT NULL DEFAULT 0,             -- số lần trả lời đúng liên tiếp (n trong SM-2)
    ease_factor       DECIMAL(4,2) NOT NULL DEFAULT 2.50,  -- hệ số dễ (EF trong SM-2), tối thiểu 1.3
    interval_days     INT NOT NULL DEFAULT 0,              -- khoảng cách (ngày) tới lần ôn kế tiếp
    next_review_date  DATE NOT NULL DEFAULT (CURRENT_DATE),
    last_quality      TINYINT NULL,                        -- 0=Again,1=Hard,2=Good,3=Easy (lần gần nhất)
    last_reviewed_at  DATETIME NULL,
    total_reviews     INT NOT NULL DEFAULT 0,
    total_correct     INT NOT NULL DEFAULT 0,
    stability         DECIMAL(8,4) NULL     COMMENT 'FSRS: stability S (ngày)',
    difficulty        DECIMAL(5,4) NULL     COMMENT 'FSRS: difficulty D (1–10)',
    fsrs_state        TINYINT NOT NULL DEFAULT 0
        COMMENT 'FSRS state: 0=New 1=Learning 2=Review 3=Relearning',
    elapsed_days      INT NOT NULL DEFAULT 0
        COMMENT 'Số ngày kể từ lần ôn trước (dùng tính retrievability R)',
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_user_word (user_id, word_id),
    KEY idx_user_due (user_id, next_review_date),
    KEY idx_user_state_due (user_id, fsrs_state, next_review_date),
    CONSTRAINT fk_wp_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_wp_word FOREIGN KEY (word_id) REFERENCES vocabulary(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2) LỊCH SỬ TRẢ LỜI (quiz + flashcard review) — dùng cho phân tích điểm yếu
CREATE TABLE IF NOT EXISTS quiz_attempts (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    user_id     INT NOT NULL,
    word_id     INT NOT NULL,
    hsk_level   INT NULL,
    word_type   VARCHAR(50) NULL,
    source      ENUM('quiz','srs') NOT NULL DEFAULT 'quiz',
    is_correct  TINYINT(1) NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    KEY idx_user_time (user_id, created_at),
    KEY idx_user_type (user_id, word_type),
    CONSTRAINT fk_qa_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_qa_word FOREIGN KEY (word_id) REFERENCES vocabulary(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3) AI RESPONSE CACHE — tránh gọi Gemini lặp lại cho cùng 1 nội dung
CREATE TABLE IF NOT EXISTS ai_cache (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    cache_key   VARCHAR(191) NOT NULL UNIQUE,   -- SHA-256(system + message) hoặc SHA-256(scope + payload)
    kind        VARCHAR(30) NOT NULL DEFAULT 'chat', -- 'chat' | 'recommend' | 'quiz_gen'
    response    MEDIUMTEXT NOT NULL,
    hit_count   INT NOT NULL DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    KEY idx_kind (kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
