#include "kh_core.h"
#include "kh_ops.h"

#include <string.h>

void kh_wipe(void *bytes, size_t len) {
    volatile unsigned char *p = (volatile unsigned char *)bytes;
    for (size_t i = 0; i < len; i++) p[i] = 0;
}

static int set_interaction(const kh_security_ops *ops, unsigned char allowed) {
    return ops->set_interaction(allowed);
}

int kh_run(const kh_security_ops *ops, const char *keychain_path, const char *service,
           unsigned int service_len, const char *account, unsigned int account_len,
           int suppress_interaction, kh_sink sink, void *sink_ctx, kh_outcome *outcome) {
    unsigned char previous = 0;
    unsigned int length = 0;
    void *buffer = NULL;
    int acquisition = KH_OK;
    int cleanup_failed = 0;
    int restore_failed = 0;
    int did_suppress = 0;

    if (outcome) {
        outcome->acquisition = KH_OK;
        outcome->final = KH_OK;
    }

    /* An explicitly supplied empty keychain path is invalid, not "absent":
     * refuse before touching any Security call so it can never fall back to
     * the default search list (review finding 1). */
    if (keychain_path != NULL && keychain_path[0] == '\0') {
        if (outcome) {
            outcome->acquisition = KH_ERR_ARGS;
            outcome->final = KH_ERR_ARGS;
        }
        return KH_ERR_ARGS;
    }

    if (suppress_interaction) {
        if (ops->get_interaction(&previous) != 0) {
            acquisition = KH_ERR_GUARD_FAILED;
            goto settle;
        }
        if (set_interaction(ops, 0) != 0) {
            /* Suppression failed; restore whatever we can and classify. */
            acquisition = (set_interaction(ops, previous) != 0) ? KH_ERR_RESTORE_FAILED
                                                               : KH_ERR_GUARD_FAILED;
            goto settle;
        }
        did_suppress = 1;
    }

    {
        const int read_status = ops->find_generic_password(
            keychain_path, service, service_len, account, account_len, &length, &buffer);
        const int received = read_status == 0 && buffer != NULL && length > 0;

        if (buffer != NULL) {
            if (length > KH_MAX_PAYLOAD) {
                acquisition = KH_ERR_PAYLOAD_TOO_LARGE;
            } else if (received) {
                if (sink == NULL || sink((const unsigned char *)buffer, length, sink_ctx) != 0)
                    acquisition = KH_ERR_PROTOCOL;
            } else {
                acquisition = KH_ERR_DENIED;
            }
            kh_wipe(buffer, length);
            if (ops->free_content(buffer) != 0) cleanup_failed = 1;
            buffer = NULL;
        } else {
            acquisition = KH_ERR_DENIED; /* error status, or success without a usable secret */
        }
    }

settle:
    if (did_suppress && set_interaction(ops, previous) != 0) restore_failed = 1;

    if (outcome) {
        outcome->acquisition = acquisition;
        outcome->final = restore_failed   ? KH_ERR_RESTORE_FAILED
                         : cleanup_failed ? KH_ERR_CLEANUP_FAILED
                                          : acquisition;
    }
    return restore_failed   ? KH_ERR_RESTORE_FAILED
           : cleanup_failed ? KH_ERR_CLEANUP_FAILED
                            : acquisition;
}
