exports.AugustPlatform = void 0;

const fs = require("fs");

const ModuleName = "homebridge-august-smart-locks";
const PlatformName = "AugustLocks";

class AugustPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.platformLog = function (msg) {
      log("[August]", msg);
    };
    this.Accessory = api.platformAccessory;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.UUIDGen = api.hap.uuid;
    this.config = config || { platform: PlatformName };
    this.email = this.config.email;
    this.phone = this.config.phone;
    this.password = this.config.password;
    this.securityToken = this.config.securityToken;
    this.code = this.config.code;
    this.installId = this.config.installId;
    this.longPoll = parseInt(this.config.longPoll, 10) || 180;
    this.shortPoll = parseInt(this.config.shortPoll, 10) || 15;
    this.shortPollDuration = parseInt(this.config.shortPollDuration, 10) || 300;
    this.tout = null;
    this.updating = false;
    this.maxCount = this.shortPollDuration / this.shortPoll;
    this.count = this.maxCount;
    this.validData = false;
    this.codeRequested = false;
    this.hideLocks = this.config.hideLocks ? this.config.hideLocks.split(",") : [];

    this.cacheDirectory = api.user.persistPath();
    this.storage = require('node-persist');
    this.storage.initSync({
      dir: this.cacheDirectory,
      forgiveParseErrors: true,
    });

    this.authed = this.storage.getItemSync('authed') || false;
    this.token = null // Session token

    this.augustApiConfig = {
      apiKey: config.securityToken || "7cab4bbd-2693-4fc1-b99b-dec0fb20f9d4", //pulled from android apk july 2020,
      installID: config.installId,
      password: config.password,
      IDType: config.email ? "email" : "phone",
      augustID: config.email ? config.email : config.phone,
    };

    this.augustApi = require("august-connect-api");
    this.manufacturer = "AUGUST";
    this.accessories = {};

    if (api) {
      this.api = api;
      this.api.on("didFinishLaunching", this.didFinishLaunching.bind(this));
    }

    // Definition Mapping
    this.lockState = ["unlock", "lock"];
  }

  // Method to setup accessories from config.json
  didFinishLaunching() {
    if ((this.email || this.phone) && this.password) {
      // Add or update accessory in HomeKit
      this.addAccessory(this.periodicUpdate.bind(this));
    } else {
      this.platformLog("Please setup August login information!");
    }
  }

  // Method to add or update HomeKit accessories
  addAccessory(callback) {
    var self = this;

    self.login(function (error) {
      if (!error) {
        self.storage.setItemSync('authed', true);
        for (var deviceID in self.accessories) {
          var accessory = self.accessories[deviceID];
          // Update inital state
          self.updatelockStates(accessory);
        }
      } else {
        self.storage.setItemSync('authed', false);
      }
      callback(error);
    });
  }

  // Method to remove accessories from HomeKit
  removeAccessory(accessory) {
    var self = this;
    if (accessory) {
      var deviceID = accessory.context.deviceID;
      accessory.context.log("Removed from HomeBridge.");
      self.api.unregisterPlatformAccessories(ModuleName, PlatformName, [accessory]);
      delete self.accessories[deviceID];
    }
  }

  // Method to restore accessories from cache
  configureAccessory(accessory) {
    var self = this;
    var accessoryID = accessory.context.deviceID;
    accessory.context.log = function (msg) {
      self.log("[" + accessory.displayName + "]", msg);
    };
    self.setService(accessory);
    self.accessories[accessoryID] = accessory;
  }

  // Method to setup listeners for different events
  setService(accessory) {
    var self = this;
    accessory
      .getService(self.Service.LockMechanism)
      .getCharacteristic(self.Characteristic.LockCurrentState)
      .on("get", self.getState.bind(self, accessory));

    accessory
      .getService(self.Service.LockMechanism)
      .getCharacteristic(self.Characteristic.LockTargetState)
      .on("get", self.getTargetState.bind(self, accessory))
      .on("set", self.setState.bind(self, accessory));


    var batteryService = accessory.getService(self.Service.BatteryService) 
    if(batteryService) {
      batteryService
        .getCharacteristic(self.Characteristic.BatteryLevel);
      batteryService
        .getCharacteristic(self.Characteristic.StatusLowBattery);

    } else {
      accessory.addService(self.Service.BatteryService);
    }

    var service = accessory.getService(self.Service.ContactSensor);

    if (service) {
      service
        .getCharacteristic(self.Characteristic.ContactSensorState)
        .on("get", self.getDoorState.bind(self, accessory));
    }

    accessory.on("identify", self.identify.bind(self, accessory));
  }

  // Method to setup HomeKit accessory information
  setAccessoryInfo(accessory) {
    var self = this;

    var informationService = accessory.getService(self.Service.AccessoryInformation);

    if (self.manufacturer) {
      informationService.setCharacteristic(self.Characteristic.Manufacturer, self.manufacturer);
    }

    if (accessory.context.serialNumber) {
      informationService.setCharacteristic(self.Characteristic.SerialNumber, accessory.context.serialNumber);
    }

    if (accessory.context.model) {
      informationService.setCharacteristic(self.Characteristic.Model, accessory.context.model);
    }
  }

  // Method to get current lock state
  getState(accessory, callback) {
    var self = this;
    self.count = 0;
    self.periodicUpdate();
    // Get target state directly from cache
    callback(null, accessory.context.currentState);
  }

  // Method to get target lock state
  getTargetState(accessory, callback) {
    var self = this;
    if (!accessory.context.targetState) {
      self.periodicUpdate();
    }
    // Get target state directly from cache
    callback(null, accessory.context.targetState);
  }

  // Method to get target door state
  getDoorState(accessory, callback) {
    var self = this;
    if (!accessory.context.doorState) {
      self.periodicUpdate();
    }
    // Get target state directly from cache
    callback(null, accessory.context.doorState);
  }

  // Method for state periodic update
  periodicUpdate() {
    var self = this;

    if (self.tout !== null) {
      clearTimeout(self.tout);
    }

    self.updateState(function (error, skipped) {
      if (!error) {
        if (!skipped) {
          // Update states for all HomeKit accessories
          for (var deviceID in self.accessories) {
            var accessory = self.accessories[deviceID];
            self.updatelockStates(accessory);
          }
        }
      } else {
        // Re-login after short polling interval if error occurs
        self.count = self.maxCount - 1;
      }
    });

    // Determine polling interval
    var refresh;
    if (self.count < self.maxCount) {
      self.count++;
      refresh = self.shortPoll;
    } else {
      refresh = self.longPoll;
    }

    // Setup periodic update with polling interval
    self.tout = setTimeout(function () {
      self.tout = null;
      self.periodicUpdate();
    }, refresh * 1000);
    // self.platformLog(`${refresh} seconds till next update`);
  }

  // Method to update lock state in HomeKit
  updatelockStates(accessory) {
    var self = this;

    var lockService = accessory.getService(self.Service.LockMechanism);
    var doorService = accessory.getService(self.Service.ContactSensor);

    if (accessory.context.doorState == 1 && accessory.context.targetState == self.Characteristic.LockCurrentState.SECURED) {
      self.platformLog(`Override locked state as jammed: ${accessory.context.targetState} - ${accessory.context.currentState}`);
      accessory.context.currentState = self.Characteristic.LockCurrentState.JAMMED;
    } else if (accessory.context.doorState == 1 && accessory.context.currentState == self.Characteristic.LockCurrentState.SECURED) {
      self.platformLog(`Override locked state as open: ${accessory.context.targetState} - ${accessory.context.currentState}`);
      accessory.context.currentState = self.Characteristic.LockCurrentState.UNSECURED;
    }

    lockService.getCharacteristic(self.Characteristic.LockTargetState).updateValue(accessory.context.targetState);
    lockService.getCharacteristic(self.Characteristic.LockCurrentState).updateValue(accessory.context.currentState);
    doorService.getCharacteristic(self.Characteristic.ContactSensorState).updateValue(accessory.context.doorState);

    var batteryService = accessory.getService(self.Service.BatteryService);
    if(batteryService) {
      batteryService
        .setCharacteristic(self.Characteristic.BatteryLevel, accessory.context.batt);

      batteryService
        .setCharacteristic(self.Characteristic.StatusLowBattery, accessory.context.low);
    }  
  }

  // Method to retrieve lock state from the server
  updateState(callback) {
    var self = this;

    if (self.updating) {
      callback(null, true);
      return;
    }

    self.updating = true;

    // Refresh data directly from sever if current data is valid
    self.getlocks(false, function (error) {
      self.updating = false;
      callback(error, false);
    });
  }

  // Method to handle identify request
  identify(accessory, paired, callback) {
    accessory.context.log("Identify requested!");
    callback();
  }

  // login auth and get token
  login(callback) {
    var self = this;

    if (this.storage.getItemSync("authed")) {
      return self.getlocks(true, callback);
    }

    var authorizeRequest = {
      config: self.augustApiConfig,
    };

    var requestingCode = false;
    if (self.code && self.code.toString().length == 6) {
      authorizeRequest.code = self.code.toString();
    } else {
      if (self.codeRequested) {
        callback();
        return;
      }
      requestingCode = true;
    }

    // Log in
    self.augustApi.authorize(authorizeRequest).then(
      function () {
        self.getlocks(true, callback);
      },
      function (error) {
        if (requestingCode) {
          self.codeRequested = true;
          self.platformLog(
            "Requesting 2FA code. Enter the received code into the configuration and restart homebridge.",
          );
          callback();
        } else {
          self.platformLog(error.body);
          self.platformLog("Login was unsuccessful, check your configuration and try again.");
          callback(error);
        }
      },
    );
  }

  getlocks(start, callback) {
    var self = this;

    // get locks
    if (start) {
      self.platformLog("getting locks ...");
    }
    self.augustApi
      .locks({
        config: self.augustApiConfig,
        token: self.token,
      })
      .then(
        function (json) {
          if (json.token != self.token) {
            self.token = json.token;
          }

          self.lockids = Object.keys(json);
          for (var i = 0; i < self.lockids.length; i++) {
            self.lock = json[self.lockids[i]];
            self.lockname = self.lock["LockName"];

            if(!self.lock || !self.lockname) {
              continue;
            }

            if (start) {
              self.platformLog(self.lock["HouseName"] + " " + self.lockname);
            }

            self.lockId = self.lockids[i];

            if (start) {
              self.platformLog("LockId " + " " + self.lockId);
            }

            if (self.lockId && !self.hideLocks.includes(self.lockId)) {
              self.getDevice(callback, self.lockId, self.lockname, self.lock["HouseName"]);
            } else if (self.accessories[self.lockId]) {
              self.removeAccessory(self.accessories[self.lockId]);
            }
          }
        },
        function (error) {
          self.platformLog("Could not communicate with August API: " + error.message);
          self.token = null;
          callback(error, null);
        },
      );
  }

  getDevice(callback, lockId, lockName, houseName) {
    var self = this;

    var getLock = self.augustApi.status({
      lockID: lockId,
      config: self.augustApiConfig,
      token: self.token,
    });

    var getDetails = self.augustApi.details({
      lockID: lockId,
      config: self.augustApiConfig,
      token: self.token,
    });

    Promise.all([getLock, getDetails]).then(
      function (values) {
        self.token = values[1].token;

        var lock = values[0]
        var locks = lock.info;

        if (!locks.bridgeID) {
          self.validData = true;
          return;
        }

        // Parse response from August
        var thisDeviceID = locks.lockID.toString();
        var thisSerialNumber = locks.serialNumber.toString();
        var thisModel = locks.lockType.toString();
        var thislockName = lockName;
        var lockState =
          lock.status == "kAugLockState_Locked"
          ? self.Characteristic.LockCurrentState.SECURED // 1
          : lock.status == "kAugLockState_Unlocked"
          ? self.Characteristic.LockCurrentState.UNSECURED // 0
          : self.Characteristic.LockCurrentState.UNSECURED; // Error, treat as unlocked

        var doorState =
          lock.doorState == "kAugDoorState_Closed"
          ? "closed"
          : lock.doorState == "kAugDoorState_Open"
          ? "open"
          : "unknown";
        var isDoorOpened = doorState == "open" ? 1 : 0;
        var thishome = houseName;

        // Retrieve accessory from cache
        var newAccessory;
        var isStateChanged = false;
        newAccessory = self.accessories[thisDeviceID];
        if (!newAccessory) {
          // Initialization for opener
          newAccessory = self.initAccessory(thisDeviceID);
          isStateChanged = true;
        }

        newAccessory.context.deviceID = thisDeviceID;
        newAccessory.context.serialNumber = thisSerialNumber;
        newAccessory.context.model = thisModel;
        newAccessory.context.home = thishome;

        // Accessory is reachable after it's found in the server
        newAccessory.updateReachability(true);

        // Battery
        self.batt = values[1].battery * 100;
        var newbatt = self.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
        if (self.batt > 0 && self.batt <= 20) {
          newbatt = self.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW;
        }

        if (self.batt) {
          newAccessory.context.low =
            (self.batt > 20 || self.batt <= 0)
            ? self.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
            : self.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW;
        }

        // Update if state change found
        var prevLockState = newAccessory.context.currentState;
        if (lockState != prevLockState) {
          self.platformLog(`Lock changed: ${lockState} was: ${prevLockState}`);
          // HomeKit will update the "Target State" to change the lock (see updateState)
          // But August can also change it e.g. via the app or Autolock.
          // Either way, if the lock state has changed, the target should now match
          newAccessory.context.targetState = lockState;
          newAccessory.context.currentState = lockState;
          isStateChanged = true;
        }

        if (isDoorOpened != newAccessory.context.doorState) {
          self.platformLog(`Door changed: ${isDoorOpened} was: ${newAccessory.context.doorState}`);
          newAccessory.context.doorState = isDoorOpened;
          isStateChanged = true;
        }

        // Store accessory in cache
        self.accessories[thisDeviceID] = newAccessory;

        // Set short polling interval when state changes
        if (isStateChanged) {
          self.count = 0;
        }

        callback();
      },
      function (error) {
        self.platformLog(`Error getting device state: ${error}`);
        self.token = null;
        callback(error, null);
      },
    );
  }

  initAccessory(thisDeviceID) {
    var self = this;

    var uuid = self.UUIDGen.generate(thisDeviceID);
    var _Accessory = self.Accessory;
    // Setup accessory as GARAGE_lock_OPENER (4) category.
    newAccessory = new _Accessory("August " + thislockName, uuid, 6);

    // Store and initialize variables into context
    newAccessory.context.initialState = self.Characteristic.LockCurrentState.SECURED;
    newAccessory.context.currentState = self.Characteristic.LockCurrentState.SECURED;
    // newAccessory.context.targetState = self.Characteristic.LockCurrentState.SECURED;
    newAccessory.context.log = function (msg) {
      self.log("[" + newAccessory.displayName + "]", msg);
    };

    newAccessory.context.batt = self.batt;
    newAccessory.context.low = self.low;
    // Setup HomeKit security systemLoc service
    newAccessory.addService(self.Service.LockMechanism, thislockName);
    newAccessory.addService(self.Service.ContactSensor, thislockName);
    newAccessory.addService(self.Service.BatteryService, thislockName);
    // Setup HomeKit accessory information
    self.setAccessoryInfo(newAccessory);
    // Setup listeners for different security system events
    self.setService(newAccessory);
    // Register accessory in HomeKit
    newAccessory.context.log("Adding lock to homebridge");
    self.api.registerPlatformAccessories(ModuleName, PlatformName, [newAccessory]);
    return newAccessory;
  }

  // Send opener target state to the server
  setState(accessory, state, callback) {
    var self = this;
    var lockCtx = accessory.context;
    lockCtx.log(`Request to change lock state: ${state}`);

    accessory.context.targetState = state;
    var status = self.lockState[state];
    var remoteOperate =
      state == self.Characteristic.LockTargetState.SECURED
      ? self.augustApi.lock({
        lockID: lockCtx.deviceID,
        config: self.augustApiConfig,
        token: self.token,
      })
      : self.augustApi.unlock({
        lockID: lockCtx.deviceID,
        config: self.augustApiConfig,
        token: self.token,
      });

    // Do an update after 1 seconds to appease Siri
    setTimeout(function() {
      setImmediate(() => {
        self.updatelockStates(accessory);
      });
      callback(null);
    }, 100
    );

    remoteOperate.then(
      function (json) {
        lockCtx.log("State was successfully set to " + status);
        self.token = json.token;

        // Set short polling interval
        if (self.tout) {
          clearTimeout(self.tout);
          self.tout = null;
        }
        self.count = 0;
        self.periodicUpdate();
        accessory.context.currentState = state;
        setImmediate(() => {
          self.updatelockStates(accessory);
        });
      },
      function (error) {
        self.platformLog("Error '" + error.message + "' setting lock state: " + status);
        self.token = null;  // Reset token in case it has expired
      },
    );
  }
}

exports.AugustPlatform = AugustPlatform;
