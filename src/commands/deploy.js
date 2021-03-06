var path = require("path");

var _ = require("lodash");
var Bacon = require("baconjs");

var AppConfig = require("../models/app_configuration.js");
var Application = require("../models/application.js");
var Git = require("../models/git.js")(path.resolve("."));
var Log = require("../models/log.js");
var Event = require("../models/events.js");

var Logger = require("../logger.js");

var timeout = 5 * 60 * 1000;

var deploy = module.exports;

deploy.deploy = function(api, params) {
  var alias = params.options.alias;
  var branch = params.options.branch;
  var quiet = params.options.quiet;
  var force = params.options.force;

  var s_appData = AppConfig.getAppData(alias).toProperty();
  var s_commitId = Git.getCommitId(branch).toProperty();

  var s_remote = s_appData.flatMapLatest(function(app_data) {
    return Git.createRemote(app_data.alias, app_data.deploy_url).toProperty();
  }).toProperty();

  var s_fetch = s_remote.flatMapLatest(function(remote) {
    return Git.keepFetching(timeout, remote);
  }).toProperty();

  var s_push = s_fetch.flatMapLatest(function(remote) {
    Logger.println("Pushing source code to Clever Cloud.");
    return Git.push(remote, branch, s_commitId, force);
  }).toProperty();

  var s_deploy = s_push.flatMapError(function(error) {
    if(error.message && error.message.trim() === "error authenticating:"){
      return new Bacon.Error(error.message.trim() + " Did you add your ssh key ?");
    } else {
      return new Bacon.Error(error);
    }
  }).toProperty();

  s_deploy.onValue(function() {
    Logger.println("Your source code has been pushed to Clever Cloud.");
  });

  handleDeployment(api, s_appData, s_deploy, s_commitId, quiet);
};

deploy.restart = function(api, params) {
  var alias = params.options.alias;
  var quiet = params.options.quiet;

  var s_appData = AppConfig.getAppData(alias).toProperty();
  var s_commitId = s_appData.flatMapLatest(function(app_data) {
    return Application.get(api, app_data.app_id, app_data.app_orga);
  }).flatMapLatest(function(app) {
    return app.commitId;
  });

  var s_deploy = s_appData.flatMapLatest(function(app_data) {
    Logger.println("Restarting " + app_data.name);
    return Application.redeploy(api, app_data.app_id, app_data.org_id);
  }).toProperty();

  handleDeployment(api, s_appData, s_deploy, s_commitId, quiet);
};

var handleDeployment = function(api, s_appData, s_deploy, s_commitId, quiet) {
  s_deploy.onValue(function(v) {
    var s_deploymentEvents = s_appData.flatMapLatest(function(appData) {
      return s_commitId.flatMapLatest(function(commitId) {
        Logger.debug("Waiting for events related to commit #" + commitId);
        return Event.getEvents(api, appData.app_id)
              .filter(function(e) {
                return e.data && e.data.commit == commitId;
              });
      });
    });

    var s_deploymentStart = s_deploymentEvents.filter(function(e) {
      return e.event === 'DEPLOYMENT_ACTION_BEGIN';
     }).first();
    s_deploymentStart.onValue(function(e) {
      Logger.println("Deployment started".bold.blue);
    });

    var s_deploymentEnd = s_deploymentEvents.filter(function(e) {
      return e.event === 'DEPLOYMENT_ACTION_END';
     }).first();

    s_deploymentEnd.onValue(function(e) {
      if(e.data.state === 'OK') {
        if(quiet) {
          Logger.println('Deployment successful'.bold.green);
        }
        process.exit(0);
      } else {
        if(quiet) {
          Logger.println('Deployment failed. Please check the logs'.bold.red);
        }
        process.exit(1);
      }
    });

    if(!quiet) {
      var s_app = s_appData
        .flatMapLatest(function(appData) {
          Logger.debug("Fetching application information…")
          return Application.get(api, appData.app_id);
        });

      var s_logs = s_app.flatMapLatest(function(app) {
        Logger.debug("Fetch application logs…");
        return Log.getAppLogs(api, app.id);
      });

      s_logs.onValue(Logger.println);
      s_logs.onError(Logger.error);
    }
  });

  s_deploy.onError(Logger.error);
};
