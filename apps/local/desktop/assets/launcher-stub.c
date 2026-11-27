#include <CoreFoundation/CoreFoundation.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static char *infoString(CFBundleRef bundle, CFStringRef key) {
  CFTypeRef value = CFBundleGetValueForInfoDictionaryKey(bundle, key);
  if (value == NULL || CFGetTypeID(value) != CFStringGetTypeID()) return NULL;
  CFIndex size =
      CFStringGetMaximumSizeForEncoding(CFStringGetLength(value), kCFStringEncodingUTF8) + 1;
  char *text = malloc(size);
  if (text == NULL || !CFStringGetCString(value, text, size, kCFStringEncodingUTF8)) return NULL;
  return text;
}

int main(void) {
  CFBundleRef bundle = CFBundleGetMainBundle();
  if (bundle == NULL) return 1;
  char *link = infoString(bundle, CFSTR("ExecutorAppLink"));
  if (link == NULL) {
    fprintf(stderr, "This launcher names no Executor app.\n");
    return 1;
  }
  char *target = infoString(bundle, CFSTR("ExecutorBundleIdentifier"));
  if (target == NULL) execl("/usr/bin/open", "open", link, (char *)NULL);
  else execl("/usr/bin/open", "open", "-b", target, link, (char *)NULL);
  perror("open");
  return 1;
}
