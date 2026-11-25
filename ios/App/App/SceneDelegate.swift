import UIKit
import Capacitor

/// The UIScene life cycle, required for apps built with the iOS 27 SDK: without
/// it the app fails to launch. UIKit builds the window from Main.storyboard
/// (UISceneStoryboardFile in Info.plist); this class only hands links on.
///
/// Under scenes, URLs and universal links no longer reach the app delegate.
/// They arrive here, and on a cold launch only in the connection options, so
/// each path forwards to ApplicationDelegateProxy exactly as AppDelegate did.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        // Launched from a killed state by a link.
        if let context = connectionOptions.urlContexts.first {
            openURL(context)
        }
        for activity in connectionOptions.userActivities {
            continueActivity(activity)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        URLContexts.forEach(openURL)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        continueActivity(userActivity)
    }

    private func openURL(_ context: UIOpenURLContext) {
        var options: [UIApplication.OpenURLOptionsKey: Any] = [:]
        options[.sourceApplication] = context.options.sourceApplication
        options[.annotation] = context.options.annotation
        options[.openInPlace] = context.options.openInPlace
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, open: context.url, options: options)
    }

    private func continueActivity(_ activity: NSUserActivity) {
        _ = ApplicationDelegateProxy.shared.application(UIApplication.shared, continue: activity, restorationHandler: { _ in })
    }
}
