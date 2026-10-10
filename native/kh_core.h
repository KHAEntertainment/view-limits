/* Core guard/read/restore sequence. OS-independent: talks only to kh_ops.h.
 * No secret is ever copied to argv, env, disk, or diagnostics here.
 */
#ifndef KH_CORE_H
#define KH_CORE_H

#include <stddef.h>
#include "kh_ops.h"
#include "kh_proto.h"

typedef struct kh_outcome {
    int acquisition; /* kh_result for the read phase */
    int final;       /* precedence-resolved code for the END frame + exit */
} kh_outcome;

/* Receives the retrieved secret in place; must not retain the pointer.
 * Return 0 on success, nonzero to fail the acquisition with KH_ERR_PROTOCOL. */
typedef int (*kh_sink)(const unsigned char *bytes, unsigned int len, void *ctx);

/* Runs: (optional) suppress interaction -> read -> sink -> wipe -> free ->
 * (optional) restore interaction. Returns outcome->final.
 * keychain_path NULL = default search list; non-NULL = isolated fixture
 * keychain opened by path (no search-list/default side effects).
 * suppress_interaction == 0 is the explicitly-interactive setup path and
 * performs no interaction-state changes at all.
 */
int kh_run(const kh_security_ops *ops, const char *keychain_path, const char *service,
           unsigned int service_len, const char *account, unsigned int account_len,
           int suppress_interaction, kh_sink sink, void *sink_ctx, kh_outcome *outcome);

/* Wipes bytes in a way the optimizer must not elide. */
void kh_wipe(void *bytes, size_t len);

#endif /* KH_CORE_H */
