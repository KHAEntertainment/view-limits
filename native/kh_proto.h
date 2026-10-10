/* Shared wire/protocol constants for the K1 keychain helper candidate.
 * Keep in sync with lib/keychain-helper.mjs. Never holds secret material.
 */
#ifndef KH_PROTO_H
#define KH_PROTO_H

/* Stable result classifications. The Node bridge maps these 1:1 to strings.
 * Values are append-only: never renumber existing codes.
 */
enum kh_result {
    KH_OK = 0,
    KH_ERR_GUARD_FAILED = 1,      /* interaction state could not be read/suppressed */
    KH_ERR_DENIED = 2,            /* read denied, auth failed, or item missing */
    KH_ERR_RESTORE_FAILED = 3,    /* prior interaction state could not be restored */
    KH_ERR_CLEANUP_FAILED = 4,    /* secret buffer could not be wiped/freed */
    KH_ERR_NO_PIPE = 5,           /* private output fd missing (direct terminal) */
    KH_ERR_PROTOCOL = 6,          /* frame write failed or malformed internally */
    KH_ERR_ARGS = 7,              /* bad invocation */
    KH_ERR_PAYLOAD_TOO_LARGE = 8, /* retrieved item exceeds KH_MAX_PAYLOAD */
    KH_ERR_RUNTIME = 9            /* platform/ABI/runtime precondition failed */
};

/* Frame: magic(4) | type(1) | flags(1) | reserved(2, LE) | length(4, LE) | payload
 * Little-endian multi-byte fields. Exactly two frames per invocation:
 *   1) KH_FRAME_SECRET (payload = secret bytes) or KH_FRAME_ERROR (payload = u32 LE code)
 *   2) KH_FRAME_END    (payload = u32 LE final code after cleanup/restore)
 */
#define KH_FRAME_MAGIC0 'K'
#define KH_FRAME_MAGIC1 'H'
#define KH_FRAME_MAGIC2 'F'
#define KH_FRAME_MAGIC3 '1'
#define KH_FRAME_HEADER_SIZE 12u
#define KH_FRAME_SECRET 1u
#define KH_FRAME_ERROR  2u
#define KH_FRAME_END    3u
/* Chrome Safe Storage passwords are tiny; hard bound keeps the bridge simple. */
#define KH_MAX_PAYLOAD 4096u
#define KH_MAX_CODE_PAYLOAD 4u

#define KH_DEFAULT_FD 3
#define KH_DEFAULT_SERVICE "Chrome Safe Storage"
#define KH_DEFAULT_ACCOUNT "Chrome"

#endif /* KH_PROTO_H */
