// Hand-written equivalent of the Go regexp (leftmost-first alternation) in ansi.go:
//
//   \x1b[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\|$)   OSC / DCS / SOS / PM / APC strings (ended by BEL, ST or the end of text)
//   \x1b\[[0-?]*[ -/]*[@-~]                      CSI
//   \x1b[ -/]*[0-~]                              any other short ESC sequence
//   \x1b                                         a lone ESC
//
// Works on bytes: the job's output is not guaranteed to be UTF-8 and Go's regexp leaves such bytes alone too.

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;

/// Length of the match that starts at s[0] == ESC. Always at least 1.
fn match_len(s: &[u8]) -> usize {
    let n = s.len();
    if n > 1 && matches!(s[1], b']' | b'P' | b'X' | b'^' | b'_') {
        let mut j = 2;
        while j < n && s[j] != BEL && s[j] != ESC {
            j += 1;
        }
        if j == n {
            return j;
        }
        if s[j] == BEL {
            return j + 1;
        }
        if j + 1 < n && s[j + 1] == b'\\' {
            return j + 2;
        }
    }
    if n > 1 && s[1] == b'[' {
        let mut j = 2;
        while j < n && (0x30..=0x3f).contains(&s[j]) {
            j += 1;
        }
        while j < n && (0x20..=0x2f).contains(&s[j]) {
            j += 1;
        }
        if j < n && (0x40..=0x7e).contains(&s[j]) {
            return j + 1;
        }
    }
    let mut j = 1;
    while j < n && (0x20..=0x2f).contains(&s[j]) {
        j += 1;
    }
    if j < n && (0x30..=0x7e).contains(&s[j]) {
        return j + 1;
    }
    1
}

pub fn strip_ansi(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        if input[i] == ESC {
            i += match_len(&input[i..]);
        } else {
            out.push(input[i]);
            i += 1;
        }
    }
    out
}
