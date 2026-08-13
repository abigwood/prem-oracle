/*
 * Filesystem, registered for the native bridge only.
 *
 * The share card is the sole reason this plugin is here: @capacitor/share takes
 * `files` as file:// URLs, so the PNG has to be written into the app's cache
 * before iOS can be handed it. Only the native build ever calls it — every call
 * site is behind isNativeApp() — so this registers the bridge name and stops
 * there rather than shipping the plugin's 30KB IndexedDB web implementation to
 * every browser that loads the site. On the web, registerPlugin's proxy simply
 * has nothing to answer with, which is the truth.
 */
var capacitorFilesystem = (function (exports, core) {
    'use strict';

    const Filesystem = core.registerPlugin('Filesystem');

    exports.Filesystem = Filesystem;

    return exports;

})({}, capacitorExports);
