#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <ImageIO/ImageIO.h>

static void fail(NSString *message) {
    fprintf(stderr, "%s\n", message.UTF8String);
    exit(1);
}

// One transient PNG on stdout. No screenshot files, video, audio or image logs.
int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc != 5) fail(@"Expected display ID, pixel width, pixel height and excluded window IDs");
        if (@available(macOS 14.0, *)) {
            CGDirectDisplayID displayID = (CGDirectDisplayID)strtoul(argv[1], NULL, 10);
            NSInteger width = atoi(argv[2]), height = atoi(argv[3]);
            if (width <= 0 || height <= 0 || width > 32768 || height > 32768) fail(@"Invalid capture dimensions");
            NSSet *excludedIDs = [NSSet setWithArray:[@(argv[4]) componentsSeparatedByString:@","]];
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 15 * NSEC_PER_SEC),
                dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{ fail(@"ScreenCaptureKit capture timed out"); });
            [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:NO
                completionHandler:^(SCShareableContent *content, NSError *error) {
                if (error) fail([@"ScreenCaptureKit: " stringByAppendingString:error.localizedDescription]);
                SCDisplay *selected = nil;
                for (SCDisplay *display in content.displays) if (display.displayID == displayID) { selected = display; break; }
                if (!selected) fail(@"Selected display is no longer available");
                NSMutableArray<SCWindow *> *excluded = [NSMutableArray array];
                for (SCWindow *window in content.windows) {
                    if ([excludedIDs containsObject:[@(window.windowID) stringValue]]) [excluded addObject:window];
                }
                SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:selected excludingWindows:excluded];
                SCStreamConfiguration *configuration = [[SCStreamConfiguration alloc] init];
                configuration.width = width;
                configuration.height = height;
                configuration.showsCursor = NO;
                [SCScreenshotManager captureImageWithFilter:filter configuration:configuration
                    completionHandler:^(CGImageRef image, NSError *captureError) {
                    if (captureError || !image) fail(captureError.localizedDescription ?: @"ScreenCaptureKit returned no image");
                    NSMutableData *png = [NSMutableData data];
                    CGImageDestinationRef destination = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)png,
                        CFSTR("public.png"), 1, NULL);
                    if (!destination) fail(@"Cannot encode captured image");
                    CGImageDestinationAddImage(destination, image, NULL);
                    BOOL encoded = CGImageDestinationFinalize(destination);
                    CFRelease(destination);
                    if (!encoded || fwrite(png.bytes, 1, png.length, stdout) != png.length) fail(@"Cannot write captured image");
                    fflush(stdout);
                    exit(0);
                }];
            }];
            dispatch_main();
        } else fail(@"Overlay-excluding area capture requires macOS 14 or later");
    }
}
