import { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { GoogleNestThermostatHandler } from './platformAccessory';
import { google, smartdevicemanagement_v1 } from 'googleapis';

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class GoogleNestPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  public readonly accessories: PlatformAccessory[] = [];

  private cached = false;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Finished initializing platform.');

    const auth = new google.auth.OAuth2(this.config.clientId, this.config.clientSecret);

    auth.setCredentials({
      refresh_token: this.config.refreshToken,
    });

    google.options({ auth });

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
    this.cached = true;
  }

  discoverDevice(
    device: smartdevicemanagement_v1.Schema$GoogleHomeEnterpriseSdmV1Device,
    gapi: smartdevicemanagement_v1.Smartdevicemanagement,
  ) {
    if (typeof device.name !== 'string') {
      return;
    }

    const uuid = this.api.hap.uuid.generate(device.name);
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

    if (existingAccessory) {
      // the accessory already exists
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

      // if you need to update the accessory.context then you should run `api.updatePlatformAccessories`. eg.:
      // existingAccessory.context.device = device;
      // this.api.updatePlatformAccessories([existingAccessory]);

      // create the accessory handler for the restored accessory
      // this is imported from `platformAccessory.ts`
      new GoogleNestThermostatHandler(this, existingAccessory, gapi);
      return;
    }

    // the accessory does not yet exist, so we need to create it
    let [{ displayName }] = device.parentRelations ?? [];
    if (!displayName) {
      displayName = 'Device ' + device.name.slice(-6);
    }
    this.log.info('Adding new accessory:', displayName);

    // create a new accessory
    const accessory = new this.api.platformAccessory(displayName, uuid);

    // store a copy of the device object in the `accessory.context`
    // the `context` property can be used to store any data about the accessory you may need
    accessory.context.displayName = displayName;
    accessory.context.name = device.name;

    // create the accessory handler for the newly create accessory
    // this is imported from `platformAccessory.ts`
    new GoogleNestThermostatHandler(this, accessory, gapi);

    // link the accessory to your platform
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  discoverDevices() {
    const sdm = google.smartdevicemanagement({
      'version': 'v1',
    });
    this.log.info('Discovering GoogleNest devices.');
    sdm.enterprises.devices.list({
      parent: 'enterprises/' + this.config.projectId,
    }).then(res => {
      if (res.data.nextPageToken) {
        this.log.error('[discoverDevices] Ignored next page token.');
      }

      if (this.cached) {
        for (const accessory of this.accessories) {
          if (!res.data.devices?.map(d => d.name).includes(accessory.context.name)) {
            this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            this.log.info('Removing existing accessory from cache:', accessory.displayName);
          }
        }
      }

      for (const device of res.data.devices ?? []) {
        this.discoverDevice(device, sdm);
      }
    });
  }
}
