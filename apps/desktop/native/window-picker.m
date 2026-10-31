#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#include <unistd.h>

// Window metadata only. Screen pixels never enter this helper.
int main(int argc, const char *argv[]) {
    pid_t excludedPID = argc > 1 ? (pid_t)atoi(argv[1]) : 0;
    while (true) {
        @autoreleasepool {
            NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(
                kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
                kCGNullWindowID));
            NSMutableArray *result = [NSMutableArray array];
            for (NSDictionary *window in windows) {
                if ([window[(id)kCGWindowOwnerPID] intValue] == excludedPID ||
                    [window[(id)kCGWindowLayer] intValue] != 0 ||
                    [window[(id)kCGWindowAlpha] doubleValue] <= 0) continue;
                CGRect bounds;
                if (!CGRectMakeWithDictionaryRepresentation(
                    (__bridge CFDictionaryRef)window[(id)kCGWindowBounds], &bounds) ||
                    bounds.size.width <= 1 || bounds.size.height <= 1) continue;
                [result addObject:@{
                    @"id": window[(id)kCGWindowNumber],
                    @"name": window[(id)kCGWindowName] ?: window[(id)kCGWindowOwnerName] ?: @"Untitled window",
                    @"bounds": @{@"x": @(bounds.origin.x), @"y": @(bounds.origin.y),
                                 @"width": @(bounds.size.width), @"height": @(bounds.size.height)}
                }];
            }
            NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
            if (!json || fwrite(json.bytes, 1, json.length, stdout) != json.length) return 1;
            fputc('\n', stdout);
            fflush(stdout);
        }
        if (argc > 2 && strcmp(argv[2], "--once") == 0) break;
        usleep(100000);
    }
}
