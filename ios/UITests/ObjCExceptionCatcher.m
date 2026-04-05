#import "ObjCExceptionCatcher.h"

@implementation ObjCExceptionCatcher

+ (BOOL)catchException:(void (^)(void))block error:(NSError *_Nullable *_Nullable)error {
    @try {
        block();
        return YES;
    } @catch (NSException *exception) {
        if (error) {
            *error = [NSError errorWithDomain:@"ObjCException"
                                         code:-1
                                     userInfo:@{
                NSLocalizedDescriptionKey: exception.reason ?: exception.name
            }];
        }
        return NO;
    } @catch (id exception) {
        if (error) {
            *error = [NSError errorWithDomain:@"ObjCException"
                                         code:-2
                                     userInfo:@{
                NSLocalizedDescriptionKey: [NSString stringWithFormat:@"Non-NSException thrown: %@", exception]
            }];
        }
        return NO;
    }
}

@end
