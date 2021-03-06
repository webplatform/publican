
var fs = require("fs")
,   jn = require("path").join
,   async = require("async")
,   dataDir = jn(__dirname, "../data")
,   ie = require("./the-index")
,   git = require("./git")
,   bs = require("./bikeshed")
,   rs = require("./respec")
,   rsync = require("./rsync")
,   cnf = require("../lib/config")
,   log = require("./log")
,   specialRepositories = [
        {
            repository: "webspecs/the-index"
        ,   branches:   {
                master: "/"
            }
        ,   noDelete:   true
        ,   regen:      "extracted"
        }
    ,   {
            repository: "webspecs/assets"
        ,   branches:   {
                master: "/assets/"
            }
        ,   regen:      "publishOnly"
        }
    ,   {
            repository: "webspecs/docs"
        ,   branches:   {
                master: "/docs/"
            }
        ,   regen:      "publishOnly"
        }
    ,   {
            repository: "webspecs/bikeshed"
        ,   branches:   {
                webspecs:   "../bikeshed/"
            }
        ,   regen:      "all"
        }
    ]
;

// XXX
//  - add caching where possible
//  - make this more robust, failing to update one repo should not block the rest

// So-called "canonical" format is the one used in specifying specialRepositories above. The
// "pairs" format has one list item per repo+branch pair and has gitDir, repo, fileName,
// and publishDir keys
exports.canonical2pairs = function (inList) {
    var outList = [];
    for (var i = 0, n = inList.length; i < n; i++) {
        var repo = inList[i];
        for (var k in repo.branches) {
            outList.push({
                gitDir:     jn(dataDir, "gits", repo.repository)
            ,   branch:     k
            ,   repository: repo.repository
            ,   publishDir: jn(dataDir, "publish", repo.branches[k])
            ,   fileName:   repo.fileName || "index"
            });
        }
    }
    return outList;
};

exports.ensureDirs = function () {
    "gits publish bikeshed queue logs"
        .split(" ")
        .forEach(function (dir) {
            dir = jn(dataDir, dir);
            log.info("Ensuring the existence of " + dir);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        })
    ;
};

exports.saveWanted = function () {
    var wanted = {};
    exports.listRepositories()
        .forEach(function (repo) {
            wanted[repo.repository] = {
                branches:   repo.branches
            ,   delete:     !repo.noDelete
            ,   fileName:   repo.fileName
            };
            if (repo.regen) wanted[repo.repository].regen = repo.regen;
        })
    ;
    log.info("Saving wanted.json");
    fs.writeFileSync(jn(dataDir, "wanted.json"), JSON.stringify(wanted, null, 4), { encoding: "utf8" });
};

// XXX this needs to happen when the-index is updated, after that it's just cached for the process
exports.commonRepositories = function () {
    var repos = {}, res = [];
    ie.extract(jn(dataDir, "publish/index.html"))
        .forEach(function (it) {
            if (!repos[it.repository]) repos[it.repository] = [];
            repos[it.repository].push(it.branch);
            repos[it.repository].fileName = it.fileName;
        })
    ;
    for (var k in repos) {
        var obj = { repository: k, branches: {}, fileName: repos[k].fileName };
        repos[k].forEach(function (branch) {
            var path = k.split("/", 2);
            obj.branches[branch] = "/" + path[1] + "/" + path[0] + "/" + branch + "/";
        });
        res.push(obj);
    }
    return res;
};

exports.listRepositories = function () {
    return [].concat(specialRepositories).concat(exports.commonRepositories());
};

exports.getRepositories = function (repos, conf, cb) {
    log.info("Cloning/fetching " + repos.length + " repositories");
    async.each(
        repos
    ,   function (repo, cb) {
            log.info("Getting: " + repo.repository + " into " + jn(dataDir, "gits", repo.repository));
            git.cloneOrFetch(conf.repoTmpl.replace("{repo}", repo.repository), jn(dataDir, "gits", repo.repository), cb);
        }
    ,   cb
    );
};

exports.publishRepositories = function (repos, conf, cb) {
    log.info("Publishing " + repos.length + " repositories");
    async.each(
        exports.canonical2pairs(repos)
    ,   function (target, cb) {
            log.info("Publishing: " + target.gitDir + ", branch " + target.branch + " into " + target.publishDir);
            // we can't git.publish the-index at all, just get the index and publish it
            if (target.repository === "webspecs/the-index") {
                log.info("Special processing for the-index");
                git.publish(
                    target.gitDir
                ,   target.branch
                ,   function (tmpDir, cb) {
                        log.info("Transforming the-index");
                        ie.transform(jn(tmpDir, "index.html"), jn(target.publishDir, "index.html"));
                        cb();
                    }
                ,   cb
                );
            }
            else {
                git.publish(target.gitDir, target.branch, target.publishDir, cb);
            }
        }
    ,   cb
    );
};

exports.transformRepositories = function (repos, conf, cb) {
    log.info("Transforming " + repos.length + " repositories");
    async.each(
        exports.canonical2pairs(repos)
    ,   function (target, cb) {
            exports.transformRepository(conf, target.publishDir, target.fileName, target.repository, cb);
        }
    ,   cb
    );
};

exports.transformRepository = function (conf, publishDir, fileName, repo, cb) {
    var baseName = jn(publishDir, fileName);
    if (fs.existsSync(baseName + ".bs")) {
        bs.bikeshed(conf.python, jn(dataDir, "bikeshed/bikeshed.py"), publishDir, fileName, cb);
    }
    else if (fs.existsSync(baseName + ".src.html")) {
        rs.respec(publishDir, fileName, repo, cb);
    }
    else cb("Failed to find either Bikeshed or ReSpec source.");
};

exports.generateRepositories = function (repositories, conf, cb) {
    async.series(
        [
            function (cb) { exports.getRepositories(repositories, conf, cb); }
        ,   function (cb) { exports.publishRepositories(repositories, conf, cb); }
        ,   function (cb) { exports.transformRepositories(repositories, conf, cb); }
        ]
    ,   cb
    );
};

// run this with extreme caution
exports.initSetup = function (cb) {
    log.log("Initialising setup");
    var conf = cnf.readConfiguration();
    exports.ensureDirs();
    
    async.series(
        [
            function (cb) {
                exports.getRepositories(specialRepositories, conf, cb);
            }
        ,   function (cb) {
                log.info("Got special repositories");
                exports.publishRepositories(specialRepositories, conf, cb);
            }
        ,   function (cb) {
                log.info("Published special repositories");
                exports.generateRepositories(exports.commonRepositories(), conf, cb);
            }
        ,   function (cb) {
                exports.saveWanted();
                cb();
            }
        ,   function (cb) {
                rsync.rsync({
                        from:   jn(dataDir, "publish/")
                    ,   to:     conf.rsyncRemote + ":" + conf.rsyncPath
                    ,   delete: true
                    }
                ,   cb
                );
            }
        ]
    ,   function (err) {
            if (err) return log.error(err);
            log.info("OK!");
            if (cb) cb();
        }
    );
};

exports.processRepository = function (data, cb) {
    var currentCommon
    ,   wantedFile = jn(dataDir, "wanted.json")
    ,   wanted = JSON.parse(fs.readFileSync(wantedFile, "utf8"))
    ,   conf = cnf.readConfiguration()
    ,   repo = data.repository
    ,   branch = data.branch
    ,   regen = wanted[repo].regen
    ,   publishDir = jn(dataDir, "publish", wanted[repo].branches[branch])
    ,   gitDir = jn(dataDir, "gits", repo)
    ;
    log.info("Hook regen mode: " + (regen || "default"));
    if (regen === "extracted") currentCommon = exports.commonRepositories();
    async.series(
        [
            function (cb) { git.cloneOrFetch(conf.repoTmpl.replace("{repo}", repo), gitDir, cb); }
        ,   function (cb) {
                if (repo === "webspecs/the-index") {
                    log.info("Special processing for the-index");
                    git.publish(
                        gitDir
                    ,   branch
                    ,   function (tmpDir, cb) {
                            log.info("Transforming the-index");
                            ie.transform(jn(tmpDir, "index.html"), jn(publishDir, "index.html"));
                            cb();
                        }
                    ,   cb
                    );
                }
                else {
                    git.publish(gitDir, branch, publishDir, cb);
                }
            }
        ,   function (cb) {
                if (regen === "all") {
                    // XXX in this case, do this instead of the per-file purge
                    // > curl -XPOST \
                    // >    'https://api.fastly.com/service/297ajaxiw26i0xh5gavhug/purge_all' \
                    // >    -H 'Fastly-Key: 09e13e3e21e03ffb21936728f37e0035' \
                    // >    -H 'Content-Accept: application/json'
                    exports.generateRepositories(exports.commonRepositories(), conf, cb);
                }
                else if (regen === "publishOnly") {
                    cb();
                }
                else if (regen === "extracted") {
                    var newCommon = exports.commonRepositories()
                    ,   oldCache = []
                    ,   newCache = []
                    ,   cacheMap = {}
                    ,   repoCache = function (arr) {
                            return function (repo) {
                                for (var k in repo.branches) {
                                    var str = repo.repository + "#" + k;
                                    arr.push(str);
                                    cacheMap[str] = repo.branches[k];
                                }
                            };
                        }
                    ;
                    currentCommon.forEach(repoCache(oldCache));
                    newCommon.forEach(repoCache(newCache));
                    var deletedRepos = oldCache.filter(function (it) { return newCache.indexOf(it) === -1; })
                    ,   newRepos = newCache.filter(function (it) { return oldCache.indexOf(it) === -1; })
                    ,   delFile = jn(dataDir, "deleted.json")
                    ;
                    if (deletedRepos.length) {
                        var delList = [];
                        if (fs.existsSync(delFile)) delList = JSON.parse(fs.readFileSync(delFile, "utf8"));
                        fs.writeFileSync(delFile, JSON.stringify(delList.concat(deletedRepos), null, 4), { encoding: "utf8" });
                        deletedRepos.forEach(function (it) {
                            var parts = it.split("#", 2)
                            ,   repo = parts[0]
                            ,   branch = parts[1]
                            ;
                            if (wanted[repo] && wanted[repo].branches[branch]) {
                                delete wanted[repo].branches[branch];
                                if (!Object.keys(wanted[repo].branches).length) delete wanted[repo];
                            }
                        });
                        fs.writeFileSync(wantedFile, JSON.stringify(wanted, null, 4), { encoding: "utf8" });
                    }
                    if (newRepos.length) {
                        var reposAsWanted = [];
                        newRepos.forEach(function (it) {
                            var parts = it.split("#", 2)
                            ,   repo = parts[0]
                            ,   branch = parts[1]
                            ,   obj = {
                                    repository: repo
                                ,   branches:   {}
                                }
                            ;
                            obj.branches[branch] = cacheMap[it];
                            reposAsWanted.push(obj);
                            if (!wanted[repo]) wanted[repo] = { branches: {} };
                            wanted[repo].branches[branch] = cacheMap[it];
                        });
                        fs.writeFileSync(wantedFile, JSON.stringify(wanted, null, 4), { encoding: "utf8" });
                        exports.generateRepositories(reposAsWanted, conf, cb);
                    }
                    else cb();
                }
                else {
                    exports.transformRepository(conf, jn(dataDir, "publish", wanted[repo].branches[branch]), wanted[repo].fileName || "index", repo, cb);
                }
            }
        ,   function (cb) { rsync.rsync({ from: jn(dataDir, "publish/"), to: conf.rsyncRemote + ":" + conf.rsyncPath, delete: true }, cb); }
        ]
    ,   cb
    );
};
