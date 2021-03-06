#! /usr/bin/env node

// Exit cleanly if the program we pipe to exits abruptly
process.stdout.on('error', function(error) {
  if(error.code == 'EPIPE') {
    process.exit(0);
  }
});

if(process.argv.indexOf("-v") >= 0 || process.argv.indexOf("--verbose") >= 0) {
  process.env["CLEVER_VERBOSE"] = "1";
}

if(process.argv.indexOf('--autocomplete-index') >= 0) {
  // Don't log anything in autocomplete mode
  process.env["CLEVER_QUIET"] = "1";
}

var _ = require("lodash");
var cliparse = require("cliparse");

var Logger = require("../src/logger.js");

var lazyRequiref = function(path, name) {
  return function() {
    var args = Array.prototype.slice.call(arguments);
    s_api.onValue(function(api) {
      var module = require(path);
      args.unshift(api);
      if(name) {
        module[name].apply(this, args);
      } else {
        module.apply(this, args);
      }
    });
  };
};

var lazyRequire = function(path) {
  return function(name) {
    return function() {
      var args = Array.prototype.slice.call(arguments);
      s_api.onValue(function(api) {
        args.unshift(api);
        var module = require(path);
        module[name].apply(this, args);
      });
    };
  };
};

var lr = function(path) {
  return function(name) {
    return function() {
      var module = require(path);
      return module[name].apply(this, arguments);
    };
  };
};

var create = lazyRequiref("../src/commands/create.js");
var link = lazyRequiref("../src/commands/link.js");
var unlink = lazyRequiref("../src/commands/unlink.js");
var env = lazyRequire("../src/commands/env.js");
var logs = lazyRequiref("../src/commands/logs.js");
var login = lazyRequiref("../src/commands/login.js");
var deploy = lazyRequire("../src/commands/deploy.js");
var cancelDeploy = lazyRequiref("../src/commands/cancel-deploy.js");
var domain = lazyRequire("../src/commands/domain.js");
var stop = lazyRequiref("../src/commands/stop.js");
var status = lazyRequiref("../src/commands/status.js");
var activity = lazyRequiref("../src/commands/activity.js");
var addon = lazyRequire("../src/commands/addon.js");
var list = lazyRequiref("../src/commands/list.js");
var scale = lazyRequiref("../src/commands/scale.js");

var Application = lr("../src/models/application.js");

function run() {
  // ARGUMENTS
  var appNameArgument = cliparse.argument("app-name", { description: "Application name" });
  var appIdArgument = cliparse.argument("app-id", { description: "Application ID (or name, if unambiguous)" });
  var aliasArgument = cliparse.argument("app-alias", { description: "Application alias" });
  var envVariableName = cliparse.argument("variable-name", { description: "Name of the environment variable" });
  var envVariableValue = cliparse.argument("variable-value", { description: "Value of the environment variable" });
  var fqdnArgument = cliparse.argument("fqdn", { description: "Domain name of the Clever Cloud application" });
  var addonIdArgument = cliparse.argument("addon-id", { description: "Addon ID" });
  var addonNameArgument = cliparse.argument("addon-name", { description: "Addon name" });
  var addonProviderArgument = cliparse.argument("addon-provider", { description: "Addon provider" });

  //PARSERS
  var flavorParser = function(flavor) {
    var flavors = Application("listAvailableFlavors")();

    if(flavors.indexOf(flavor) == -1) {
      return cliparse.parsers.error("Invalid value: " + flavor);
    } else {
      return cliparse.parsers.success(flavor);
    }
  };

  var instancesParser = function(instances) {
    var parsedInstances = parseInt(instances, 10);
    if (isNaN(parsedInstances)) {
      return cliparse.parsers.error("Invalid number: " + instances);
    } else {
      if (parsedInstances < 1 || parsedInstances > 20) {
        return cliparse.parsers.error("The number of instances must be between 1 and 20");
      } else {
        return cliparse.parsers.success(parsedInstances);
      }
    }
  };

  // OPTIONS
  var orgaOption = cliparse.option("orga", { aliases: ["o"], description: "Organisation ID" });
  var aliasCreationOption = cliparse.option("alias", {
      aliases: ["a"],
      metavar: "alias",
      description: "Short name for the application" });
  var aliasOption = cliparse.option("alias", {
      aliases: ["a"],
      metavar: "alias",
      description: "Short name for the application",
      complete: Application("listAvailableAliases") });
  var instanceTypeOption = cliparse.option("type", {
      aliases: ["t"],
      required: true,
      metavar: "type",
      description: "Instance type",
      complete: Application("listAvailableTypes") });
  var regionOption = cliparse.option("region", {
      aliases: ["r"],
      default: "par",
      metavar: "zone",
      description: "Region, can be 'par' for Paris or 'mtl' for Montreal",
      complete: Application("listAvailableZones") });
  var branchOption = cliparse.option("branch", {
      aliases: ["b"],
      default: "",
      metavar: "branch",
      description: "Branch to push (current branch by default)",
      complete: function() {
        var path = require("path");
        var Git = require("../src/models/git.js")(path.resolve("."));
        return Git.completeBranches() } });
  var verboseOption = cliparse.flag("verbose", { aliases: ["v"], description: "Verbose output" });
  var showAllActivityOption = cliparse.flag("show-all", { description: "Show all activity" });
  var showAllAddonsOption = cliparse.flag("show-all", { description: "Show all available addons" });
  var followOption = cliparse.flag("follow", { aliases: ["f"], description: "Track new deployments in activity list" });
  var quietOption = cliparse.flag("quiet", { aliases: ["q"], description: "Don't show logs during deployment" });
  var forceDeployOption = cliparse.flag("force", { aliases: ["f"], description: "Force deploy even if it's not fast-forwardable" });
  var addonRegionOption = cliparse.option("region", {
      alias: ["r"],
      default: "eu",
      metavar: "region",
      description: "Region to provision the addon in, depends on the provider",
      complete: addon("completeRegion")
  });
  var addonPlanOption = cliparse.option("plan", {
      alias: ["p"],
      default: "dev",
      metavar: "plan",
      description: "Addon plan, depends on the provider",
      complete: addon("completePlan")
  });
  var confirmAddonCreationOption = cliparse.flag("yes", { aliases: ["y"], description: "Skip confirmation even if the addon is not free" });
  var confirmAddonDeletionOption = cliparse.flag("yes", { aliases: ["y"], description: "Skip confirmation and delete the addon directly" });
  var sourceableEnvVarsList = cliparse.flag("add-export", { aliases: [], description: "Display sourceable env variables setting" });
  var onlyAliasesOption = cliparse.flag("only-aliases", { aliases: [], description: "List only application aliases" });
  var minFlavorOption = cliparse.option("min-flavor", {
    metavar: "minflavor",
    parser: flavorParser,
    description: "The minimum scale for your application",
    complete: function() {return cliparse.autocomplete.words(Application("listAvailableFlavors")())}
  });
  var maxFlavorOption = cliparse.option("max-flavor", {
    metavar: "maxflavor",
    parser: flavorParser,
    description: "The maximum scale for your application",
    complete: function() {return cliparse.autocomplete.words(Application("listAvailableFlavors")())}
  });
  var flavorOption = cliparse.option("flavor", {
    metavar: "flavor",
    parser: flavorParser,
    description: "The scale of your application",
    complete: function() {return cliparse.autocomplete.words(Application("listAvailableFlavors")())}
  });
  var minInstancesOption = cliparse.option("min-instances", {
    metavar: "mininstances",
    parser: instancesParser,
    description: "The minimum number of parallels instances"
  });
  var maxInstancesOption = cliparse.option("max-instances", {
    metavar: "maxinstances",
    parser: instancesParser,
    description: "The maximum number of parallels instances"
  });
  var instancesOption = cliparse.option("instances", {
    metavar: "instances",
    parser: instancesParser,
    description: "The number of parallels instances"
  });

  // CREATE COMMAND
  var appCreateCommand = cliparse.command("create", {
    description: "Create a Clever Cloud application",
    args: [appNameArgument],
    options: [
      orgaOption,
      aliasCreationOption,
      instanceTypeOption,
      regionOption
    ]
  }, create);

  // LINK COMMAND
  var appLinkCommand = cliparse.command("link", {
    description: "Link this repo to an existing Clever Cloud application",
    args: [appIdArgument],
    options: [
      aliasCreationOption
    ]
  }, link);

  // UNLINK COMMAND
  var appUnlinkCommand = cliparse.command("unlink", {
    description: "Unlink this repo from an existing Clever Cloud application",
    args: [aliasArgument]
  }, unlink);

  // ENV COMMANDS
  var envSetCommand = cliparse.command("set", {
    description: "Add or update an environment variable named <variable-name> with the value <variable-value>",
    args: [
      envVariableName,
      envVariableValue
    ]
  }, env("set"));

  var envRemoveCommand = cliparse.command("rm", {
    description: "Remove an environment variable from a Clever Cloud application",
    args: [
      envVariableName
    ]
  }, env("rm"));

  var envImportCommand = cliparse.command("import", {
    description: "Load environment variables from STDIN",
    args: [
    ]
  }, env("importEnv"));

  var envCommands = cliparse.command("env", {
    description: "Manage Clever Cloud application environment",
    options: [
      aliasOption,
      sourceableEnvVarsList
    ],
    commands: [
      envSetCommand,
      envRemoveCommand,
      envImportCommand
    ]
  }, env("list"));

  // LOGS COMMAND
  var logsCommand = cliparse.command("logs", {
    description: "Fetch application logs, continuously",
    options: [
      aliasOption
    ]
  }, logs);

  // LOGIN COMMAND
  var loginCommand = cliparse.command("login", {
    description: "Login to Clever Cloud"
  }, login);

  // CANCEL DEPLOY COMMAND
  var cancelDeployCommand = cliparse.command("cancel-deploy", {
    description: "Cancel an ongoing deployment on Clever Cloud",
    options: [
      aliasOption
    ]
  }, cancelDeploy);

  // DEPLOY COMMAND
  var deployCommand = cliparse.command("deploy", {
    description: "Deploy an application to Clever Cloud",
    options: [
      aliasOption,
      branchOption,
      quietOption,
      forceDeployOption
    ]
  }, deploy("deploy"));

  // RESTART COMMAND
  var restartCommand = cliparse.command("restart", {
    description: "Start or restart a Clever Cloud application",
    options: [
      aliasOption,
      quietOption
    ]
  }, deploy("restart"));

  // DOMAIN COMMANDS
  var domainCreateCommand = cliparse.command("add", {
    description: "Add a domain name to a Clever Cloud application",
    args: [
      fqdnArgument
    ]
  }, domain("add"));

  var domainRemoveCommand = cliparse.command("rm", {
    description: "Remove a domain name from a Clever Cloud application",
    args: [
      fqdnArgument
    ]
  }, domain("rm"));

  var domainCommands = cliparse.command("domain", {
    description: "Manage Clever Cloud application domain names",
    options: [
      aliasOption
    ],
    commands: [
      domainCreateCommand,
      domainRemoveCommand
    ]
  }, domain("list"));

  // STOP COMMAND
  var stopCommand = cliparse.command("stop", {
    description: "Stop a running application on Clever Cloud",
    options: [
      aliasOption
    ]
  }, stop);

  // STATUS COMMAND
  var statusCommand = cliparse.command("status", {
    description: "See the status of an application on Clever Cloud",
    options: [
      aliasOption
    ]
  }, status);

  // ACTIVITY COMMAND
  var activityCommand = cliparse.command("activity", {
    description: "Show last deployments of a Clever Cloud application",
    options: [
      aliasOption,
      followOption,
      showAllActivityOption
    ]
  }, activity);

  // ADDON COMMANDS
  var addonCreateCommand = cliparse.command("create", {
    description: "Create an addon and link it to this application",
    args: [ addonProviderArgument, addonNameArgument ],
    options: [
      confirmAddonCreationOption,
      addonPlanOption,
      addonRegionOption
    ]
  }, addon("create"));

  var addonLinkCommand = cliparse.command("link", {
    description: "Link an existing addon to this application",
    args: [
      addonIdArgument
    ]
  }, addon("link"));

  var addonUnlinkCommand = cliparse.command("unlink", {
    description: "Unlink an addon from this application",
    args: [
      addonIdArgument
    ]
  }, addon("unlink"));

  var addonDeleteCommand = cliparse.command("delete", {
    description: "Delete an addon",
    options: [
      confirmAddonDeletionOption,
    ],
    args: [
      addonIdArgument
    ]
  }, addon("delete"));

  var addonRenameCommand = cliparse.command("rename", {
    description: "Rename an addon",
    args: [
      addonIdArgument,
      addonNameArgument
    ]
  }, addon("rename"));

  var addonShowProviderCommand = cliparse.command("show", {
    description: "Show information about an addon provider",
    args: [addonProviderArgument]
  }, addon("showProvider"));

  var addonProvidersCommand = cliparse.command("providers", {
    description: "List available addon providers",
    args: [],
    commands: [
      addonShowProviderCommand
    ]
  }, addon("listProviders"));

  var addonCommands = cliparse.command("addon", {
    description: "Manage addons",
    options: [
      aliasOption,
      showAllAddonsOption
    ],
    commands: [
      addonCreateCommand,
      addonLinkCommand,
      addonUnlinkCommand,
      addonDeleteCommand,
      addonRenameCommand,
      addonProvidersCommand
    ]
  }, addon("list"));

  //LIST COMMAND
  var listCommand = cliparse.command("list", {
    description: "List linked applications",
    options: [ onlyAliasesOption ],
  }, list);

  //SCALE COMMAND
  var scaleCommand = cliparse.command("scale", {
    description: "Change scalability of an application",
    options: [
      aliasOption,
      flavorOption,
      minFlavorOption,
      maxFlavorOption,
      instancesOption,
      minInstancesOption,
      maxInstancesOption
    ]
  }, scale);

  // CLI PARSER
  var cliParser = cliparse.cli({
    name: "clever",
    description: "CLI tool to manage Clever Cloud data and products",
    version: "0.3.4",
    options: [ verboseOption ],
    commands: [
      appCreateCommand,
      appLinkCommand,
      appUnlinkCommand,
      envCommands,
      logsCommand,
      loginCommand,
      cancelDeployCommand,
      deployCommand,
      restartCommand,
      domainCommands,
      stopCommand,
      statusCommand,
      activityCommand,
      addonCommands,
      listCommand,
      scaleCommand
    ]
  });

  cliparse.parse(cliParser);
}
var s_api = require("../src/models/api.js")();

s_api.onError(Logger.error.bind(console));
run();
