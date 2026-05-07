struct Config {
    message_len: u32,
    nonce_index: u32,
    batch_size: u32,
    T: array<u32, 8>,
};
struct OutputBuffer {
    count: atomic<u32>,
    winners: array<u32>,
};
@group(0) @binding(0) var<storage,read> data: array<u32>;
@group(0) @binding(1) var<storage,read_write> result: OutputBuffer;
@group(0) @binding(2) var<storage,read> cfg: Config;

// // BLAKE2s INITIALIZATION VECTOR (IV) & PARAMETER BLOCK
// =============================================================================
// The IV constants are the same as SHA-256 (square roots of the first 8 primes).
//
// In the constructor of '@noble/hashes', h[0] is XOR'd with a 'Parameter Block'.
// This block packs configuration settings into a single 32-bit integer:
//
// Formula: output_len | (key_len << 8) | (fanout << 16) | (max_depth << 24)
// For this miner: 32 | (0 << 8) | (1 << 16) | (1 << 24) = 0x01010020
//
// 0x20: Digest length (32 bytes / 256 bits)
// 0x00: Key length (0 bytes - no secret key/MAC used)
// 0x01: Fanout (1 - default for sequential hashing)
// 0x01: Max Depth (1 - default for sequential hashing)
//
// Formula: output_len | (key_len << 8) | (fanout << 16) | (max_depth << 24)
// Result:  32         | (0 << 8)       | (1 << 16)      | (1 << 24) = 0x01010020
//
// +----------+----------+----------+----------+
// | Byte 4   | Byte 3   | Byte 2   | Byte 1   |
// | (<< 24)  | (<< 16)  | (<< 8)   | (None)   |
// +----------+----------+----------+----------+
// | Max Depth| Fanout   | Key Len  | Out Len  |
// |   0x01   |   0x01   |   0x00   |   0x20   |
// +----------+----------+----------+----------+
//
// Initial SHA256 state from RFC 6234 §6.1: the first 32 bits of the fractional parts of the
// square roots of the first eight prime numbers. Exported as a shared table; callers must treat
// it as read-only because constructors copy words from it by index 
// ====
const IV: array<u32,8> = array<u32,8>(
    0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au, 0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u,
);

// =============================================================================
// SIGMA TABLE (The Cryptographic "Shuffle Schedule")
// =============================================================================
// This 2D array dictates exactly which piece of your 64-byte message chunk 
// gets injected into the hash state during each of the 10 mixing rounds.
//
// The table has 10 rows (one for each round) and 16 columns (one for each 
// 4-byte word in your chunk). 
//
// WHY WE NEED THIS:
// If we just mixed the message words in order (0, 1, 2, 3...) every round, 
// the hash would be predictable and vulnerable. By scrambling the order using 
// this exact, mathematically proven sequence, we guarantee the "Avalanche Effect"—
// meaning a single flipped bit in your JSON template cascades into a completely 
// chaotic and unpredictable final hash.
// =============================================================================
const SIGMA: array<array<u32, 16>, 10> = array<array<u32, 16>, 10>(
    // Round 0: Words are used exactly in order.
    array<u32, 16>(0u, 1u, 2u, 3u, 4u, 5u, 6u, 7u, 8u, 9u, 10u, 11u, 12u, 13u, 14u, 15u),
    // Round 1: Total scramble (e.g., the first word mixed is now m[14]).
    array<u32, 16>(14u, 10u, 4u, 8u, 9u, 15u, 13u, 6u, 1u, 12u, 0u, 2u, 11u, 7u, 5u, 3u),
    // Round 2
    array<u32, 16>(11u, 8u, 12u, 0u, 5u, 2u, 15u, 13u, 10u, 14u, 3u, 6u, 7u, 1u, 9u, 4u),
    // Round 3
    array<u32, 16>(7u, 9u, 3u, 1u, 13u, 12u, 11u, 14u, 2u, 6u, 5u, 10u, 4u, 0u, 15u, 8u),
    // Round 4
    array<u32, 16>(9u, 0u, 5u, 7u, 2u, 4u, 10u, 15u, 14u, 1u, 11u, 12u, 6u, 8u, 3u, 13u),
    // Round 5
    array<u32, 16>(2u, 12u, 6u, 10u, 0u, 11u, 8u, 3u, 4u, 13u, 7u, 5u, 15u, 14u, 1u, 9u),
    // Round 6
    array<u32, 16>(12u, 5u, 1u, 15u, 14u, 13u, 4u, 10u, 0u, 7u, 6u, 3u, 9u, 2u, 8u, 11u),
    // Round 7
    array<u32, 16>(13u, 11u, 7u, 14u, 12u, 1u, 3u, 9u, 5u, 0u, 15u, 4u, 8u, 6u, 2u, 10u),
    // Round 8
    array<u32, 16>(6u, 15u, 14u, 9u, 11u, 3u, 0u, 8u, 12u, 2u, 13u, 7u, 1u, 4u, 10u, 5u),
    // Round 9: The final scramble.
    array<u32, 16>(10u, 2u, 8u, 4u, 7u, 6u, 1u, 5u, 15u, 11u, 9u, 14u, 3u, 12u, 13u, 0u)
);

// =============================================================================
// BITWISE RIGHT ROTATE (The "Circular Shift")
// =============================================================================
// Imagine a 32-slot combination lock. If you shift all the numbers to the right,
// the numbers that fall off the right side loop back around to fill the empty 
// slots on the left.
//
// @param x - The 32-bit unsigned integer you want to spin.
// @param n - How many positions to spin it to the right.
// =============================================================================
fn rotr(x: u32, n: u32) -> u32 {

    // Step 1: (x >> n)
    // The '>>' shifts the bits to the right. The bits on the far right fall off 
    // and disappear. The new empty spaces on the left become 0s.
    // Example: 11110000 >> 4 becomes 00001111

    // Step 2: (x << (32u - n))
    // The '<<' shifts left. We calculate (32 - n) to grab ONLY the bits that 
    // fell off during Step 1, and move them to the very top (the left side).

    // Step 3: The bitwise OR (|)
    // Mashing the two halves back together.
    return (x >> n) | (x << (32u - n));
}

// =============================================================================
// THE 'G' MIXING FUNCTION (The Cryptographic Blender)
// =============================================================================
// This mixes two pieces of your message (x and y) into four specific 
// slots (a, b, c, d) of the 16-word working vector (*v).
//
// It uses a strict sequence of: ADD -> XOR -> ROTATE
// By the end of this function, changing a single bit in 'x' or 'y' will 
// cause massive, unpredictable changes across a, b, c, and d.
//
// @param v - A pointer to our 16-word working array.
// @param a, b, c, d - The specific indices (0-15) inside 'v' we are modifying.
// @param x, y - Two 32-bit chunks of your JSON template.
// =============================================================================
fn G(v: ptr<function, array<u32, 16>>, a: u32, b: u32, c: u32, d: u32, x: u32, y: u32) {

    // -------------------------------------------------------------------------
    // FIRST HALF (Mixes 'x' into the state)
    // -------------------------------------------------------------------------

    // 1. Add 'b' and the message 'x' into 'a'.
    // WGSL strictly uses 32-bit math. If it goes over the max limit, 
    // it automatically wraps around to 0 (like a car odometer).
    (*v)[a] = (*v)[a] + (*v)[b] + x;

    // 2. Mix the new 'a' into 'd' using XOR (^), then spin it 16 bits.
    // XOR flips the bits of 'd' based on 'a'. Rotating by 16 basically 
    // swaps the left and right halves of the number.
    (*v)[d] = rotr((*v)[d] ^ (*v)[a], 16u);

    // 3. Add the newly scrambled 'd' into 'c'.
    (*v)[c] = (*v)[c] + (*v)[d];

    // 4. Mix 'c' into 'b' using XOR, then spin it 12 bits.
    (*v)[b] = rotr((*v)[b] ^ (*v)[c], 12u);

    // -------------------------------------------------------------------------
    // SECOND HALF (Mixes 'y' into the state)
    // -------------------------------------------------------------------------

    // 5. Add 'b' and the second message chunk 'y' into 'a'.
    // We are mutating 'a' for a second time, piling chaos on top of chaos.
    (*v)[a] = (*v)[a] + (*v)[b] + y;

    // 6. Mix 'a' into 'd' again, spin by 8 bits.
    (*v)[d] = rotr((*v)[d] ^ (*v)[a], 8u);

    // 7. Add 'd' into 'c' again.
    (*v)[c] = (*v)[c] + (*v)[d];

    // 8. Mix 'c' into 'b' again, spin by 7 bits.
    (*v)[b] = rotr((*v)[b] ^ (*v)[c], 7u);

    // no 'return' statement, because we used a pointer (*v), the actual array sitting in the 
    // 'compress' function has been permanently modified.
}

fn initialize_state() -> array<u32,8> {
    var h: array<u32, 8>;
    h[0] = IV[0];
    h[1] = IV[1];
    h[2] = IV[2];
    h[3] = IV[3];
    h[4] = IV[4];
    h[5] = IV[5];
    h[6] = IV[6];
    h[7] = IV[7];

    h[0] = h[0] ^ 0x01010020u;
    return h;
}

// This is if we havent taken care of padding in js
//fn load_chunk_from_template(chunk_idx: u32) -> array<u32, 16> {
//    var chunk: array<u32, 16>;

    // Each chunk is 16 u32 words (64 bytes)
//    let start_word = chunk_idx * 16u;

//    for (var i = 0u; i < 16u; i++) {
//        let global_word_idx = start_word + i;

        // Check if this word is within the bounds of our message
        // cfg.message_len is in bytes, so we compare against (word_idx * 4)
//      if global_word_idx * 4u < cfg.message_len {

//          var val = data[global_word_idx];

            // EDGE CASE: If the message ends in the middle of this u32 word,
            // we must mask out the "garbage" bytes that belong to the next block
            // or the end of the buffer.
//          let bytes_into_word = cfg.message_len - (global_word_idx * 4u);
//          if bytes_into_word < 4u {
                // Create a mask to keep only the valid bytes
                // e.g., if only 2 bytes are valid, mask is 0x0000FFFF
//               let mask = (1u << (8u * bytes_into_word)) - 1u;
//                val = val & mask;
//          }

//        chunk[i] = val;
//     } else {
            // Beyond the message length: fill with 0 (Standard BLAKE2 padding)
//        chunk[i] = 0u;
//     }
//  }

//   return chunk;
//}

fn load_chunk_from_template(chunk_idx: u32, ascii_nonce: array<u32, 2>) -> array<u32, 16> {
    var chunk: array<u32, 16>;
    let start_word = chunk_idx * 16u;

    for (var i = 0u; i < 16u; i++) {
        let global_word_idx = start_word + i;

        // 1. Load the template data (already padded by Bun)
        if global_word_idx * 4u < cfg.message_len {
            chunk[i] = data[global_word_idx];
        } else {
            chunk[i] = 0u; // This covers the rest of the 64-byte block
        }
        // 2. Overwrite 2 consecutive words at the nonce index (8 hex chars).
        if global_word_idx == cfg.nonce_index {
            chunk[i] = ascii_nonce[0];
        }
        if global_word_idx == cfg.nonce_index + 1u {
            chunk[i] = ascii_nonce[1];
        }
    }
    return chunk;
}

// =============================================================================
// THE 'COMPRESS' FUNCTION (The Engine Room)
// =============================================================================
//
// This is the central "engine room" of the BLAKE2s algorithm. It is broken
// down into four distinct phases:
//   1. Initialization - building the 16-word working vector from IV + state
//   2. Configuration  - stamping byte counter and finalization flag
//   3. The 10 Rounds  - column + diagonal mixing via the G function
//   4. Finalization   - folding 16 words back into 8 output words
//
// =============================================================================
// This function takes a 64-byte chunk of your template and mathematically 
// crushes it into the current hash state. 
//
// @param h_in - The current 8-word hash state (either the Initial Vector, 
//               or the result from the previous chunk).
// @param m - The "message": a 16-word (64-byte) chunk of your JSON template.
// @param bytes_processed - The branchless counter we calculated earlier.
// @param is_last - True if this is the final chunk of the message.
// @returns The new, updated 8-word hash state.
// =============================================================================
fn compress(h_in: array<u32, 8>, m: array<u32, 16>, bytes_processed: u32, is_last: bool) -> array<u32, 8> {

    // -------------------------------------------------------------------------
    // PHASE 1: INITIALIZE THE WORKING VECTOR ('v')
    // -------------------------------------------------------------------------
    // BLAKE2s uses a temporary 16-word array called 'v' to do its mixing.
    // We build this by stacking the current state on top of the static IVs.
    var v: array<u32, 16>;
    for (var i = 0u; i < 8u; i++) {
        v[i] = h_in[i];       // The top 8 words are your current progress.
        v[i + 8u] = IV[i];    // The bottom 8 words are the mathematical constants.
    }

    // -------------------------------------------------------------------------
    // PHASE 2: INJECT CONFIGURATION & SECRETS
    // -------------------------------------------------------------------------
    // We mathematically stamp the byte counter into v[12]. This ensures that 
    // hashing 64 bytes of zeros produces a different result than hashing 128 
    // bytes of zeros (preventing length-extension attacks).
    v[12] = v[12] ^ bytes_processed;

    // v[13] is used for file sizes larger than 4 Gigabytes. Since your template 
    // is only ~290 bytes, this is always 0. We can safely skip v[13].

    // The Finalization Flag. If this is the last chunk, we flip all the bits 
    // of v[14] (XOR with 0xFFFFFFFF). We use 'select' to keep this branchless!
    v[14] = select(v[14], v[14] ^ 0xFFFFFFFFu, is_last);

    // -------------------------------------------------------------------------
    // PHASE 3: THE 10 ROUNDS (The Shuffle)
    // -------------------------------------------------------------------------
    // We run the 'G' mixing function 10 times. Each round uses the SIGMA table 
    // to decide which pieces of your message (m) to inject.
    //
    // Notice the pattern:
    // 1. We mix straight down the columns (0, 4, 8, 12).
    // 2. We mix diagonally across the columns (0, 5, 10, 15).
    // This design (borrowed from the ChaCha cipher) ensures rapid "avalanche".
    for (var r = 0u; r < 10u; r++) {

        // --- COLUMN MIXING ---
        // Mixes vertical columns of the 4x4 matrix
        G(&v, 0u, 4u, 8u, 12u, m[SIGMA[r][0]], m[SIGMA[r][1]]);
        G(&v, 1u, 5u, 9u, 13u, m[SIGMA[r][2]], m[SIGMA[r][3]]);
        G(&v, 2u, 6u, 10u, 14u, m[SIGMA[r][4]], m[SIGMA[r][5]]);
        G(&v, 3u, 7u, 11u, 15u, m[SIGMA[r][6]], m[SIGMA[r][7]]);

        // --- DIAGONAL MIXING ---
        // Mixes diagonal lines across the 4x4 matrix
        G(&v, 0u, 5u, 10u, 15u, m[SIGMA[r][8]], m[SIGMA[r][9]]);
        G(&v, 1u, 6u, 11u, 12u, m[SIGMA[r][10]], m[SIGMA[r][11]]);
        G(&v, 2u, 7u, 8u, 13u, m[SIGMA[r][12]], m[SIGMA[r][13]]);
        G(&v, 3u, 4u, 9u, 14u, m[SIGMA[r][14]], m[SIGMA[r][15]]);
    }

    // -------------------------------------------------------------------------
    // PHASE 4: FINALIZATION (The Fold)
    // -------------------------------------------------------------------------
    // After 10 rounds, our working vector 'v' is heavily scrambled.
    // We now "fold" the 16 words of 'v' back down into the 8 words of 'h_out'.
    // 
    // We do this by XORing the original state (h_in), the top half of v, 
    // and the bottom half of v all together.
    var h_out: array<u32, 8>;
    for (var i = 0u; i < 8u; i++) {
        h_out[i] = h_in[i] ^ v[i] ^ v[i + 8u];
    }

    // Return the new 32-byte hash state!
    return h_out;
}

// =============================================================================
// DIFFICULTY CHECK (256-bit Integer Comparison)
// =============================================================================
fn meets_difficulty(h: array<u32, 8>, T: array<u32, 8>) -> bool {
    // Both h and T are LE u32 words, LSW first (matching CPU hex comparison).
    // Compare from LSW (index 0) upward — first differing word decides.
    for (var i = 0u; i < 8u; i++) {
        if h[i] < T[i] { return true; }
        if h[i] > T[i] { return false; }
    }
    return false;
}

// =============================================================================
// ASCII HEX GENERATOR (Prevents Invalid JSON)
// =============================================================================
// Converts a raw Thread ID into 8 printable ASCII Hex characters (little-endian
// nibble order: nibble 0 → byte 0). Returns 2 packed u32 words so the nonce
// occupies 8 consecutive bytes in the buffer, giving a 32-bit search space.
// =============================================================================
fn thread_id_to_ascii_hex(id: u32) -> array<u32, 2> {
    var result: array<u32, 2>;
    result[0] = 0u;
    result[1] = 0u;

    // A 32-bit ID has 8 nibbles → 8 hex characters.
    for (var i = 0u; i < 8u; i++) {
        // Isolate the nibble at position i (little-endian: LSB first).
        let nibble = (id >> (i * 4u)) & 0xFu;

        // Translate 0-9 → '0'-'9' (0x30), 10-15 → 'a'-'f' (0x57 offset).
        var ascii: u32;
        if nibble < 10u {
            ascii = 0x30u + nibble;
        } else {
            ascii = 0x57u + nibble;
        }

        // Pack into word 0 (chars 0-3) or word 1 (chars 4-7).
        let word_idx = i / 4u;
        let byte_in_word = i % 4u;
        result[word_idx] = result[word_idx] | (ascii << (byte_in_word * 8u));
    }

    return result;
}

/* 
   VISUAL TRACE OF THREAD ID #0x12345678 (8-char, 2 words):
   
   Nibbles (LE): i=0→8, i=1→7, i=2→6, i=3→5, i=4→4, i=5→3, i=6→2, i=7→1
   
   Word 0 (chars 0-3): '8','7','6','5' → 0x35363738
   Word 1 (chars 4-7): '4','3','2','1' → 0x31323334
   
   GPU writes both words at nonce_index and nonce_index+1.
   Node.js reads the 8 bytes LE as: "87654321".
*/

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let thread_id = id.x;
    if thread_id >= cfg.batch_size { return; }
    var h = initialize_state();
    let ascii_nonce = thread_id_to_ascii_hex(thread_id);

    // Calculate the number of 64-byte chunks needed to process the message.
    // We use (len + 63) / 64 to perform a 'ceiling division'. This ensures that 
    // partial chunks are 
    // accounted for in the loop.
    // Example: (290 + 63) / 64 = 5 chunks.
    let total_chunks = (cfg.message_len + 63u) / 64u;

    // This loop replaces the entire 'update' logic.
    for (var i = 0u; i < total_chunks; i++) {
        let is_last = (i == total_chunks - 1u); // We know it's last if it's the final iteration

        // 1. Load the "Chunk" (Equivalent to filling the 'buffer' in JS)
        let chunk = load_chunk_from_template(i, ascii_nonce);

        // =============================================================================
        // BYTE COUNTER (Branchless Optimization)
        // =============================================================================
        // BLAKE2s requires a running counter of total bytes processed to be mixed 
        // into the state. For normal chunks, this is: (chunk_index + 1) * 64.
        // For the final chunk, we must use the EXACT message length (e.g., 290) 
        // so the padded zeros aren't counted as real data.
        //
        // PERFORMANCE NOTE:
        // We use the built-in 'select(false_val, true_val, condition)' instead of 
        // an if/else block. This avoids "warp divergence" on the GPU, keeping all 
        // 64 threads in the workgroup executing flawlessly in parallel without pausing.
        //
        // select(value_if_false, value_if_true, condition)
        //
        // =============================================================================
        let bytes_hashed = select((i + 1u) * 64u, cfg.message_len, is_last);

        // 2. Immediate Compress (No waiting!)
        // We pass 'is_last' directly because we know the future.
        h = compress(h, chunk, bytes_hashed, is_last);
    }

    // Compare hash directly (LSW-first LE words) against target.
    if meets_difficulty(h, cfg.T) {

        // We found a block!
        // Pass a pointer directly to the 'count' property of our struct
        let winner_index = atomicAdd(&result.count, 1u);

        // Write our thread_id to the normal array (no atomicStore needed!)
        if winner_index < 10u {
            result.winners[winner_index] = thread_id;
        }
    }
}
