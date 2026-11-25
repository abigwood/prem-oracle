// v1.8.1 (34) — the iOS app adopts the UIScene life cycle.
//
// Build 33 was the first archived with the iOS 27 SDK, which refuses to launch
// an app without scenes ("UIScene life cycle is required for apps built with
// this SDK"). It crashed on every launch. These pin the three pieces that make
// launch work: the scene manifest, the SceneDelegate compiled into the App
// target, and links forwarded from the scene to Capacitor's proxy — cold
// launch included, which arrives only in the connection options.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../ios/App/${path}`, import.meta.url), "utf8");
const PLIST = read("App/Info.plist");
const PBX = read("App.xcodeproj/project.pbxproj");
const SCENE = read("App/SceneDelegate.swift");
const APP_DELEGATE = read("App/AppDelegate.swift");

test("Info.plist declares one window scene, built by SceneDelegate from Main.storyboard", () => {
  const manifest = /<key>UIApplicationSceneManifest<\/key>\s*<dict>([\s\S]*?<\/array>)/.exec(PLIST)?.[1];
  assert.ok(manifest, "no UIApplicationSceneManifest — the iOS 27 SDK will not launch the app");
  assert.match(manifest, /<key>UIApplicationSupportsMultipleScenes<\/key>\s*<false\/>/);
  assert.match(manifest, /<key>UIWindowSceneSessionRoleApplication<\/key>/);
  assert.match(manifest, /<key>UISceneDelegateClassName<\/key>\s*<string>\$\(PRODUCT_MODULE_NAME\)\.SceneDelegate<\/string>/);
  assert.match(manifest, /<key>UISceneStoryboardFile<\/key>\s*<string>Main<\/string>/);
  // The app-level storyboard key would build a second, scene-less window.
  assert.doesNotMatch(PLIST, /UIMainStoryboardFile/);
});

test("SceneDelegate.swift is in the App target's group and compiled in its Sources phase", () => {
  const ref = /(\w{24}) \/\* SceneDelegate\.swift \*\/ = \{isa = PBXFileReference;[^}]*path = SceneDelegate\.swift;/.exec(PBX)?.[1];
  assert.ok(ref, "no file reference");
  const build = new RegExp(`(\\w{24}) /\\* SceneDelegate\\.swift in Sources \\*/ = \\{isa = PBXBuildFile; fileRef = ${ref} `).exec(PBX)?.[1];
  assert.ok(build, "no build file");
  const sources = /isa = PBXSourcesBuildPhase;[\s\S]*?files = \(([\s\S]*?)\);/.exec(PBX)?.[1] || "";
  assert.ok(sources.includes(`${build} /* SceneDelegate.swift in Sources */`), "not compiled");
  assert.ok(sources.includes("/* AppDelegate.swift in Sources */"));
});

test("links reach Capacitor from the scene: cold launch, open URL and universal link", () => {
  assert.match(SCENE, /class SceneDelegate: UIResponder, UIWindowSceneDelegate/);
  // Cold launch: only the connection options carry the link.
  assert.match(SCENE, /willConnectTo[\s\S]*connectionOptions\.urlContexts[\s\S]*connectionOptions\.userActivities/);
  assert.match(SCENE, /func scene\(_ scene: UIScene, openURLContexts/);
  assert.match(SCENE, /func scene\(_ scene: UIScene, continue userActivity: NSUserActivity\)/);
  assert.match(SCENE, /ApplicationDelegateProxy\.shared\.application\(UIApplication\.shared, open: context\.url/);
  assert.match(SCENE, /ApplicationDelegateProxy\.shared\.application\(UIApplication\.shared, continue: activity/);
});

test("the app delegate keeps push registration and gives up the window", () => {
  assert.match(APP_DELEGATE, /didRegisterForRemoteNotificationsWithDeviceToken[\s\S]*capacitorDidRegisterForRemoteNotifications/);
  assert.match(APP_DELEGATE, /didFailToRegisterForRemoteNotificationsWithError[\s\S]*capacitorDidFailToRegisterForRemoteNotifications/);
  assert.match(APP_DELEGATE, /configurationForConnecting[\s\S]*"Default Configuration"/);
  assert.doesNotMatch(APP_DELEGATE, /var window/);
});
