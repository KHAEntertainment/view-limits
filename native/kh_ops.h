/* Security backend seam: exactly one object file provides `kh_security`
 * (native/kh_security_real.c for the real build, test/kh_fake_security.c
 * for KH_SYNTHETIC builds). Core logic never includes Security.framework.
 */
#ifndef KH_OPS_H
#define KH_OPS_H

typedef struct kh_security_ops {
    /* Returns 0 on success. */
    int (*get_interaction)(unsigned char *allowed);
    /* Returns 0 on success. */
    int (*set_interaction)(unsigned char allowed);
    /* keychain_path: NULL = default search list (production path). Non-NULL =
     * open that keychain file by path (fixture path) WITHOUT consulting or
     * modifying the search list or default keychain. Returns 0 on success and
     * sets length/out only on success. On success the caller owns the buffer
     * and must wipe then free it. */
    int (*find_generic_password)(const char *keychain_path, const char *service,
                                 unsigned int service_len, const char *account,
                                 unsigned int account_len, unsigned int *length, void **out);
    /* Wipes/frees a buffer returned by find_generic_password. Returns 0 on success. */
    int (*free_content)(void *password);
} kh_security_ops;

extern const kh_security_ops kh_security;

#endif /* KH_OPS_H */
