// backend/srs.js
// ════════════════════════════════════════════════════════════════
//  Thuật toán FSRS-4.5 (Free Spaced Repetition Scheduler)
//  Pham et al., 2022 — https://github.com/open-spaced-repetition/fsrs4anki
//
//  Ưu điểm so với SM-2:
//  • Dùng mô hình trí nhớ "Three-Component Model" (stability, difficulty, retrievability)
//  • Khoảng ôn tập được tối ưu theo xác suất nhớ thực tế (desired retention = 90%)
//  • Stability tăng tỉ lệ với độ khó và mức độ quên — học sâu hơn SM-2
//  • Được validate trên 100M+ lần ôn tập thực tế (Anki dataset)
//
//  TRẠNG THÁI mỗi thẻ (lưu trong word_progress):
//    state:      0=New | 1=Learning | 2=Review | 3=Relearning
//    stability:  S — số ngày dự kiến nhớ ở mức R=90% (càng lớn = càng nhớ lâu)
//    difficulty: D — độ khó cá nhân (1=dễ nhất, 10=khó nhất)
//
//  ĐÁNH GIÁ: Again=1 / Hard=2 / Good=3 / Easy=4
//  (ánh xạ 1-1 với UI, khác SM-2 dùng 0-3)
// ════════════════════════════════════════════════════════════════

// Trọng số mặc định FSRS-4.5 (pre-trained trên dataset Anki)
const W = [
    0.4072, 1.1829, 3.1262, 15.4722,  // w0-w3: initial stability theo rating
    7.2102, 0.5316, 1.0651,  0.0589,  // w4-w7: difficulty init + update
    1.4684, 0.1070, 1.0097,  1.9395,  // w8-w11: stability after recall / forget
    0.1100, 0.2900, 2.2700,  0.1500,  // w12-w15
    2.9898, 0.5100,                    // w16-w17
];

const DECAY             = -0.5;
const FACTOR            = Math.pow(0.9, 1 / DECAY) - 1; // ≈ 19/81 ≈ 0.2346
const DESIRED_RETENTION = 0.9;        // mức xác suất nhớ mục tiêu

// ── Utility ──────────────────────────────────────────────────
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

/**
 * Hàm forgetting curve của FSRS (Power Law of Forgetting):
 * R(t, S) = (1 + FACTOR * t/S)^DECAY
 * Với t=0 → R=1 (nhớ 100%), t→∞ → R→0
 */
function retrievability(elapsed_days, stability) {
    if (!stability || stability <= 0) return 0;
    return Math.pow(1 + FACTOR * elapsed_days / stability, DECAY);
}

/** Stability ban đầu sau lần học đầu tiên theo rating */
function initStability(rating) { return Math.max(W[rating - 1], 0.1); }

/** Difficulty ban đầu theo rating (1–10) */
function initDifficulty(rating) {
    return clamp(W[4] - Math.exp(W[5] * (rating - 1)) + 1, 1, 10);
}

/** Cập nhật difficulty sau mỗi lần ôn (có mean reversion về D_0(4)) */
function updateDifficulty(d, rating) {
    const d_prime = d - W[6] * (rating - 3);
    const d0_easy = initDifficulty(4);              // mean reversion target
    return clamp(W[7] * d0_easy + (1 - W[7]) * d_prime, 1, 10);
}

/** Stability mới sau khi nhớ (rating ≥ 2) */
function stabilityAfterRecall(d, s, r, rating) {
    const hard_penalty = rating === 2 ? W[15] : 1.0;
    const easy_bonus   = rating === 4 ? W[16] : 1.0;
    const factor = Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) *
                   (Math.exp(W[10] * (1 - r)) - 1) * hard_penalty * easy_bonus;
    return Math.max(s * (factor + 1), 0.1);
}

/** Stability mới sau khi quên (rating = 1) */
function stabilityAfterForgetting(d, s, r) {
    return Math.max(
        W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r)),
        0.1
    );
}

/**
 * Interval tối ưu = stability (ngày) — tại đó R = DESIRED_RETENTION.
 * Chứng minh: R(S, S) = (1 + FACTOR*1)^DECAY = 0.9^(-2*-0.5... )
 * Thực ra next_interval = S / FACTOR * (R^(1/DECAY) - 1) = S (khi R=0.9)
 */
function nextInterval(stability) {
    return Math.max(1, Math.round(stability));
}

// ── Main export ───────────────────────────────────────────────
/**
 * Tính trạng thái FSRS tiếp theo.
 * @param {Object} prev   Trạng thái hiện tại từ DB
 * @param {1|2|3|4} rating  Again=1 Hard=2 Good=3 Easy=4
 */
function computeNextState(prev, rating) {
    const state        = prev?.fsrs_state ?? 0;
    const s            = prev?.stability  ?? 0;
    const d            = prev?.difficulty ?? initDifficulty(3);
    const elapsed      = prev?.elapsed_days ?? 0;

    let new_s, new_d, new_state, interval;

    // ── New card (chưa từng học) ──────────────────────────────
    if (state === 0) {
        new_s     = initStability(rating);
        new_d     = initDifficulty(rating);
        new_state = rating === 1 ? 1 : 2;   // Again → Learning, còn lại → Review
        interval  = rating === 1 ? 0 : nextInterval(new_s);
    }
    // ── Learning / Relearning (ôn lại trong ngày) ────────────
    else if (state === 1 || state === 3) {
        new_s     = initStability(rating);
        new_d     = updateDifficulty(d, rating);
        new_state = rating === 1 ? state : 2;
        interval  = rating === 1 ? 0 : nextInterval(new_s);
    }
    // ── Review (ôn tập định kỳ dài hạn) ─────────────────────
    else {
        const r = retrievability(elapsed, s);
        new_d     = updateDifficulty(d, rating);
        if (rating === 1) {
            new_s     = stabilityAfterForgetting(d, s, r);
            new_state = 3;   // Relearning
            interval  = 0;
        } else {
            new_s     = stabilityAfterRecall(d, s, r, rating);
            new_state = 2;
            interval  = nextInterval(new_s);
        }
    }

    const next = new Date();
    next.setHours(0, 0, 0, 0);
    next.setDate(next.getDate() + interval);

    //  Format bằng các thành phần ngày giờ ĐỊA PHƯƠNG (getFullYear/getMonth/getDate) thay vì
    // chuyển qua UTC để tránh lệch ngày.
    const y   = next.getFullYear();
    const m   = String(next.getMonth() + 1).padStart(2, '0');
    const day = String(next.getDate()).padStart(2, '0');

    return {
        stability:      Math.round(new_s * 10000) / 10000,
        difficulty:     Math.round(new_d * 10000) / 10000,
        fsrs_state:     new_state,
        interval_days:  interval,
        next_review_date: `${y}-${m}-${day}`,
        is_correct:     rating >= 3 ? 1 : 0,
    };
}

module.exports = { computeNextState, retrievability, initStability, initDifficulty, W };
