"use strict";

// Include Node packages
var del = require("del");
var browserSync = require("browser-sync");
var swig = require("swig");
var swigExtras = require("swig-extras");
var yaml = require("js-yaml");
var fs = require("fs");
var through = require("through2");
var extend = require("util")._extend;
var path = require("path");
var merge = require("merge-stream");
var requireDir = require("require-dir");

// Include Gulp and plugins
var gulp = require("gulp");
var $ = require("gulp-load-plugins")();
var exclude = require("gulp-ignore").exclude;

// Include local packages
var locals = {};
try {
  locals = requireDir("local_node_modules", { camelcase: true });
} catch (err) {}

var AUTOPREFIXER_BROWSERS = [
  "ie >= 10",
  "ie_mob >= 10",
  "ff >= 30",
  "chrome >= 34",
  "safari >= 7",
  "opera >= 23",
  "ios >= 7",
  "android >= 4.4",
  "bb >= 10",
];

// Lint JavaScript
gulp.task(
  "js",
  gulp.series(async function () {
    return gulp
      .src("app/scripts/**/*.js")
      .pipe($.uglify({ preserveComments: "some" }))
      .pipe(gulp.dest("dist/scripts"));
  })
);

// Bower
gulp.task(
  "bower",
  gulp.series(async function () {
    return $.bower()
      .pipe(exclude("**/.*"))
      .pipe(exclude("**/*.md"))
      .pipe(exclude("**/*.json"))
      .pipe(exclude("**/*.coffee"))
      .pipe(exclude("**/src/**"))
      .pipe(gulp.dest("dist/lib"));
  })
);

// Optimize Images
gulp.task(
  "media",
  gulp.series(async function () {
    var stream1 = gulp
      .src("app/media/**/*")
      .pipe(gulp.dest("dist/media"))
      .pipe($.size({ title: "media" }));

    var stream2 = gulp
      .src("app/images/**/*")
      .pipe(
        $.cache(
          $.imagemin({
            progressive: true,
            interlaced: true,
            svgoPlugins: [{ removeTitle: true }],
          })
        )
      )
      .pipe(gulp.dest("dist/images"))
      .pipe($.size({ title: "images" }));

    return merge(stream1, stream2);
  })
);

// Copy All Files At The Root Level (app) and lib
gulp.task(
  "copy",
  gulp.series(async function () {
    return gulp
      .src(["app/*", "!app/html", "!app/data"], { dot: true })
      .pipe(gulp.dest("dist"))
      .pipe($.size({ title: "copy" }));
  })
);

// Libs
gulp.task(
  "lib",
  gulp.series(async function () {
    return gulp
      .src(["app/lib/**/*"], {
        dot: true,
      })
      .pipe(gulp.dest("dist/lib"))
      .pipe($.size({ title: "lib" }));
  })
);

// Copy Web Fonts To Dist
gulp.task(
  "fonts",
  gulp.series(async function () {
    return gulp
      .src(["app/fonts/**"])
      .pipe(gulp.dest("dist/fonts"))
      .pipe($.size({ title: "fonts" }));
  })
);

// Compile and Automatically Prefix Stylesheets
gulp.task(
  "styles",
  gulp.series(async function () {
    // For best performance, don't add Sass partials to `gulp.src`
    return (
      $.rubySass(["app/styles/*.scss", "app/styles/**/*.css"], {
        style: "expanded",
        precision: 10,
      })
        .pipe($.changed("styles", { extension: ".scss" }))
        .pipe($.autoprefixer(AUTOPREFIXER_BROWSERS))
        .pipe(gulp.dest(".tmp/styles"))
        // Concatenate And Minify Styles
        .pipe($.if("*.css", $.csso()))
        .pipe(gulp.dest("dist/styles"))
        .pipe($.size({ title: "styles" }))
    );
  })
);

// HTML
gulp.task(
  "html",
  gulp.series(async function () {
    var globalData = {};

    fs.readdirSync("app/data").forEach(function (filename) {
      var path = "app/data/" + filename;
      var stat = fs.statSync(path);
      if (stat.isFile() && /.yaml$/.test(filename)) {
        var obj = yaml.load(fs.readFileSync(path, "utf8"));
        globalData[filename.replace(/\..*/, "")] = obj;
      }
    });

    var pages = [];

    return (
      gulp
        .src(["app/html/**/*.html", "!app/html/**/_*.html"])
        // Extract frontmatter
        .pipe(
          $.frontMatter({
            property: "frontMatter",
            remove: true,
          })
        )
        // Start populating context data for the file, globalData, followed by file's frontmatter
        .pipe(
          $.tap(function (file, t) {
            file.contextData = extend(extend({}, globalData), file.frontMatter);
          })
        )
        // Handle generator files
        .pipe(
          $.if(
            "$*.html",
            through.obj(function (file, enc, callback) {
              // Pull out generator info and find the collection
              var gen = file.frontMatter.generate;
              var collection = globalData[gen.collection];
              // Create a new file for each item in the collection
              for (var i = 0; i < collection.length; i++) {
                var item = collection[i];
                var newFile = file.clone();
                newFile.contextData[gen.variable] = item;
                newFile.path = path.join(
                  newFile.base,
                  swig.render(gen.filename, { locals: newFile.contextData })
                );
                this.push(newFile);
              }
              callback();
            })
          )
        )
        // Populate the global pages collection
        // Wait for all files first (to collect all front matter)
        .pipe($.util.buffer())
        .pipe(
          through.obj(function (filesArray, enc, callback) {
            var me = this;
            filesArray.forEach(function (file) {
              var pageInfo = { path: file.path, data: file.frontMatter || {} };
              pages.push(pageInfo);
            });
            // Re-emit each file into the stream
            filesArray.forEach(function (file) {
              me.push(file);
            });
            callback();
          })
        )
        .pipe(
          $.tap(function (file, t) {
            // Finally, add pages array to collection
            file.contextData = extend(file.contextData, { all_pages: pages });
          })
        )
        // Run everything through swig templates
        .pipe(
          $.swig({
            setup: function (sw) {
              swigExtras.useFilter(sw, "markdown");
              swigExtras.useFilter(sw, "trim");
              sw.setFilter("material_color", function (input) {
                var parts = input.toLowerCase().split(/\s+/g);
                if (parts[0] == "material" && parts.length >= 3) {
                  return locals["material-color"](parts[1], parts[2]);
                }
                return input;
              });
            },
            data: function (file) {
              return file.contextData;
            },
            defaults: {
              cache: false,
            },
          })
        )
        // Concatenate And Minify JavaScript
        .pipe($.if("*.js", $.uglify({ preserveComments: "some" })))
        // Concatenate And Minify Styles
        // In case you are still using useref build blocks
        .pipe($.if("*.css", $.csso()))
        // Minify Any HTML
        .pipe(gulp.dest(".tmp"))
        .pipe($.if("*.html", $.minifyHtml()))
        // Output Files
        .pipe(gulp.dest("dist"))
        .pipe($.size({ title: "html" }))
    );
  })
);

// Clean Output Directory
gulp.task(
  "clean",
  gulp.series(async function () {
    del([".tmp", "dist"]);
    $.cache.clearAll();
  })
);

// Watch Files For Changes & Reload
gulp.task(
  "serve",
  gulp.series(gulp.parallel("styles", "bower", "html"), async function () {
    browserSync({
      notify: false,
      // Run as an https by uncommenting 'https: true'
      // Note: this uses an unsigned certificate which on first access
      //       will present a certificate warning in the browser.
      // https: true,
      server: {
        baseDir: [".tmp", "app"],
      },
    });

    gulp
      .watch("app/data/**/*")
      .on("change", gulp.series("html", browserSync.reload));
    gulp
      .watch("app/html/**/*.html")
      .change("change", gulp.series("html", browserSync.reload));
    gulp
      .watch("app/styles/**/*.{scss,css}")
      .change("change", gulp.series("styles", browserSync.reload));
    gulp
      .watch("app/scripts/**/*.js")
      .change("change", gulp.series("js", browserSync.reload));
    gulp
      .watch("app/media/**/*")
      .change("change", gulp.series(browserSync.reload));
    gulp
      .watch("app/media/**/*")
      .change("change", gulp.series(browserSync.reload));
    gulp
      .watch("app/images/**/*")
      .change("change", gulp.series(browserSync.reload));
    gulp
      .watch("app/templates/**/*")
      .change("change", gulp.series(browserSync.reload));
  })
);

// Build Production Files, the Default Task
gulp.task(
  "default",
  gulp.series(
    "clean",
    "styles",
    gulp.parallel("js", "bower", "html", "media", "fonts", "lib", "copy")
  )
);

// Build and serve the output from the dist build
gulp.task(
  "serve:dist",
  gulp.series("default", async function () {
    browserSync({
      notify: false,
      // Run as an https by uncommenting 'https: true'
      // Note: this uses an unsigned certificate which on first access
      //       will present a certificate warning in the browser.
      // https: true,
      server: "dist",
    });
  })
);

// Deploy to GitHub pages
gulp.task(
  "deploy",
  gulp.series(async function () {
    return gulp.src("dist/**/*", { dot: true }).pipe(
      $.ghPages({
        remoteUrl: "https://github.com/santhoshvai/portfolio.git",
      })
    );
  })
);

// Load custom tasks from the `tasks` directory
try {
  requireDir("tasks");
} catch (err) {}
