/* Real macOS backend. Compiled only in the real build; never executed by the
 * synthetic test suite. Read-only against the file-based keychain search list:
 * this file never creates keychains, never touches the search list or default
 * keychain, and never changes item permissions.
 */
#if !defined(__APPLE__)
#error "kh-security-real requires macOS"
#endif

#include "kh_ops.h"

#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>

#if defined(__MAC_OS_X_VERSION_MIN_REQUIRED) && __MAC_OS_X_VERSION_MIN_REQUIRED < 101500
#error "kh-security-real deployment target must be >= macOS 10.15"
#endif

static int real_get_interaction(unsigned char *allowed) {
/* Deprecation accepted DELIBERATELY, not overlooked: SecKeychain* is
 * deprecated since macOS 10.10, yet SecItem's interaction-suppression
 * mechanisms do not work for file-based keychains, which is exactly why
 * Chromium still calls SecKeychainSetUserInteractionAllowed (see its
 * scoped_keychain_user_interaction_allowed.cc, FB16959400). Apple TN3137
 * confirms SecKeychain always targets the file-based keychain. */
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    Boolean value = 0;
    if (SecKeychainGetUserInteractionAllowed(&value) != errSecSuccess) return -1;
    *allowed = value ? 1u : 0u;
    return 0;
}

static int real_set_interaction(unsigned char allowed) {
    return SecKeychainSetUserInteractionAllowed(allowed ? true : false) == errSecSuccess ? 0 : -1;
}

static int real_find_generic_password(const char *keychain_path, const char *service,
                                      unsigned int service_len, const char *account,
                                      unsigned int account_len, unsigned int *length,
                                      void **out) {
    UInt32 len = 0;
    void *buffer = NULL;
    OSStatus status;
    SecKeychainRef fixture = NULL;
    if (keychain_path != NULL) {
        /* Explicit-but-empty is invalid: refuse instead of degrading to the
         * default search list (review finding 1). Absent (NULL) stays the
         * documented production search-list path. */
        if (keychain_path[0] == '\0') return (int)errSecParam;
        /* Fixture path: open by path only. SecKeychainOpen does not modify the
         * search list or default keychain; the lookup below is confined to
         * this keychain file, never the user's login/System keychains. */
        status = SecKeychainOpen(keychain_path, &fixture);
        if (status != errSecSuccess) return (int)status;
    }
    /* NULL keychain -> default search list, read-only lookup. */
    status = SecKeychainFindGenericPassword(fixture, (UInt32)service_len, service,
                                            (UInt32)account_len,
                                            account_len ? account : NULL, &len, &buffer, NULL);
    if (fixture != NULL) CFRelease(fixture);
    if (status != errSecSuccess) return (int)status;
    *length = (unsigned int)len;
    *out = buffer;
    return 0;
}

static int real_free_content(void *password) {
    return SecKeychainItemFreeContent(NULL, password) == errSecSuccess ? 0 : -1;
}

const kh_security_ops kh_security = {
    real_get_interaction,
    real_set_interaction,
    real_find_generic_password,
    real_free_content,
};
#pragma clang diagnostic pop
