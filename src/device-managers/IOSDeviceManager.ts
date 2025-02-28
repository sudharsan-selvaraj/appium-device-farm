import Simctl from 'node-simctl';
import { flatten, isEmpty } from 'lodash';
import { utilities as IOSUtils } from 'appium-ios-device';
import { IDevice } from '../interfaces/IDevice';
import { IDeviceManager } from '../interfaces/IDeviceManager';
import { getFreePort } from '../helpers';
import { asyncForEach } from '../helpers';
import log from '../logger';
import os from 'os';
import path from 'path';
import { getUtilizationTime } from '../device-utils';
import fs from 'fs-extra';
import Devices from './cloud/Devices';
import NodeDevices from './NodeDevices';
import { IosTracker } from './iOSTracker';
import { addNewDevice, removeDevice } from '../data-service/device-service';
import { DeviceTypeToInclude, IDerivedDataPath, IPluginArgs } from '../interfaces/IPluginArgs';

export default class IOSDeviceManager implements IDeviceManager {
  constructor(
    private pluginArgs: IPluginArgs,
    private hostPort: number,
  ) {}
  /**
   * Method to get all ios devices and simulators
   *
   * @returns {Promise<Array<IDevice>>}
   */
  async getDevices(
    deviceTypes: { iosDeviceType: DeviceTypeToInclude },
    existingDeviceDetails: Array<IDevice>,
  ): Promise<IDevice[]> {
    if (deviceTypes.iosDeviceType === 'real') {
      return flatten(
        await Promise.all([
          this.getRealDevices(existingDeviceDetails, this.pluginArgs, this.hostPort),
        ]),
      );
    } else if (deviceTypes.iosDeviceType === 'simulated') {
      const simulators = flatten(await Promise.all([this.getSimulators()]));
      log.debug(`Simulators: ${JSON.stringify(simulators)}`);
      return simulators;
    } else {
      // return both real and simulated devices
      return flatten(
        await Promise.all([
          this.getRealDevices(existingDeviceDetails, this.pluginArgs, this.hostPort),
          this.getSimulators(),
        ]),
      );
    }
  }

  async getConnectedDevices(): Promise<Array<string>> {
    try {
      const devices: string[] = await IOSUtils.getConnectedDevices();
      return devices;
    } catch (error) {
      log.error(error);
      return [];
    }
  }

  async getOSVersion(udid: string) {
    return await IOSUtils.getOSVersion(udid);
  }

  async getDeviceName(udid: string) {
    return await IOSUtils.getDeviceName(udid);
  }

  private getDevicePlatformName(name: string) {
    return name.toLowerCase().includes('tv') ? 'tvos' : 'ios';
  }

  /**
   * Method to get all ios real devices
   *
   * @returns {Promise<Array<IDevice>>}
   */
  private async getRealDevices(
    existingDeviceDetails: Array<IDevice>,
    pluginArgs: IPluginArgs,
    hostPort: number,
  ): Promise<Array<IDevice>> {
    let deviceState: Array<IDevice> = [];
    if (this.pluginArgs.cloud !== undefined) {
      const cloud = new Devices(this.pluginArgs.cloud, deviceState, 'ios');
      return await cloud.getDevices();
    } else {
      deviceState = await this.fetchLocalIOSDevices(existingDeviceDetails, pluginArgs, hostPort);
    }
    const returnDevices = deviceState.filter((device) => device.realDevice === true);
    return returnDevices;
  }

  private prepareDerivedDataPath(
    derivedDataPath: IDerivedDataPath | undefined,
    udid: string,
    realDevice: boolean,
  ): string {
    function derivedPathExtracted(tmpPath: string, theDerivedDataPath?: string) {
      if (theDerivedDataPath !== undefined) {
        fs.copySync(theDerivedDataPath, tmpPath);
      } else {
        if (!fs.existsSync(tmpPath)) {
          log.info(`DerivedDataPath for UDID ${udid} not set, so falling back to ${tmpPath}`);
          log.info(
            `WDA will be build once and will use WDA Runner from path ${tmpPath}, second test run will skip the build process`,
          );
          fs.mkdirSync(tmpPath, { recursive: true });
        }
      }
    }

    if (derivedDataPath) {
      if (typeof derivedDataPath !== 'object')
        throw new Error('DerivedData Path should be able Object');
      const tmpPath = path.join(
        os.homedir(),
        `Library/Developer/Xcode/DerivedData/WebDriverAgent-${udid}`,
      );
      if (realDevice) {
        derivedPathExtracted(tmpPath, derivedDataPath.device);
      } else {
        derivedPathExtracted(tmpPath, derivedDataPath.simulator);
      }
      return tmpPath;
    } else {
      return path.join(os.homedir(), `Library/Developer/Xcode/DerivedData/WebDriverAgent-${udid}`);
    }
  }

  private async fetchLocalIOSDevices(
    existingDeviceDetails: IDevice[],
    pluginArgs: IPluginArgs,
    hostPort: number,
  ): Promise<IDevice[]> {
    const devices = await this.getConnectedDevices();
    const deviceState: IDevice[] = [];
    await asyncForEach(devices, async (udid: string) => {
      const existingDevice = existingDeviceDetails.find((device) => device.udid === udid);
      if (existingDevice) {
        log.info(`IOS Device details for ${udid} already available`);
        deviceState.push({
          ...existingDevice,
          busy: false,
          userBlocked: false,
        });
      } else {
        const deviceInfo = await this.getDeviceInfo(udid, pluginArgs, hostPort);
        deviceState.push(deviceInfo);
      }
    });
    // might as well track devices
    this.trackIOSDevices(pluginArgs);

    return deviceState;
  }

  async trackIOSDevices(pluginArgs: IPluginArgs) {
    const iosTracker = IosTracker.getInstance();
    iosTracker.on('attached', async (udid: string) => {
      const deviceAttached = [await this.getDeviceInfo(udid, pluginArgs, this.hostPort)];
      if (pluginArgs.hub !== undefined) {
        log.info(`Updating Hub with iOS device ${udid}`);
        const nodeDevices = new NodeDevices(pluginArgs.hub);
        await nodeDevices.postDevicesToHub(deviceAttached, 'add');
      }
      // add device to local list
      log.info(`iOS device with udid ${udid} plugged! updating device list...`);
      addNewDevice(deviceAttached, pluginArgs.bindHostOrIp);
    });
    iosTracker.on('detached', async (udid: string) => {
      const deviceRemoved: any = [{ udid, host: pluginArgs.bindHostOrIp }];
      if (pluginArgs.hub !== undefined) {
        log.info(`iOS device with udid ${udid} unplugged! updating hub device list...`);
        const nodeDevices = new NodeDevices(pluginArgs.hub);
        await nodeDevices.postDevicesToHub(deviceRemoved, 'remove');
      }

      // remove device from local list
      log.info(`iOS device with udid ${udid} unplugged! updating device list...`);
      removeDevice(deviceRemoved);
    });
  }

  private async getDeviceInfo(
    udid: string,
    pluginArgs: IPluginArgs,
    hostPort: number,
  ): Promise<IDevice> {
    let host;
    if (pluginArgs.remoteMachineProxyIP) {
      host = pluginArgs.remoteMachineProxyIP;
    } else {
      host = `http://${pluginArgs.bindHostOrIp}:${hostPort}`;
    }
    const wdaLocalPort = await getFreePort();
    const mjpegServerPort = await getFreePort();
    const totalUtilizationTimeMilliSec = await getUtilizationTime(udid);
    const [sdk, name] = await Promise.all([this.getOSVersion(udid), this.getDeviceName(udid)]);
    return Object.assign({
      wdaLocalPort,
      mjpegServerPort,
      udid,
      sdk,
      name,
      busy: false,
      realDevice: true,
      deviceType: 'real',
      platform: this.getDevicePlatformName(name),
      host,
      totalUtilizationTimeMilliSec: totalUtilizationTimeMilliSec,
      sessionStartTime: 0,
      derivedDataPath: this.prepareDerivedDataPath(pluginArgs.derivedDataPath, udid, true),
    });
  }

  /**
   * Method to get all ios simulators
   *
   * @returns {Promise<Array<IDevice>>}
   */
  public async getSimulators(): Promise<Array<IDevice>> {
    const simulators = await this.fetchLocalSimulators();
    simulators.sort((a, b) => (a.state > b.state ? 1 : -1));

    // should not be here, but we need to update the hub with simulators
    /*if (this.pluginArgs.hub !== undefined) {
      log.info('Updating Hub with Simulators');
      const nodeDevices = new NodeDevices(this.pluginArgs.hub);
      await nodeDevices.postDevicesToHub(simulators, 'add');
    }*/

    return simulators;
  }

  public async fetchLocalSimulators() {
    log.debug('Fetching local simulators');
    const returnedSimulators: IDevice[] = [];
    const flattenValued = await this.getLocalSims();
    let filteredSimulators: Array<IDevice> = [];
    const localPluginArgs = this.pluginArgs;
    if (this.pluginArgs.simulators !== undefined) {
      filteredSimulators = flattenValued.filter((device: IDevice) =>
        localPluginArgs.simulators.some(
          (simulator: IDevice) => device.name === simulator.name && device.sdk === simulator.sdk,
        ),
      );
    }
    //log.debug(`Filtered Simulators: ${JSON.stringify(filteredSimulators)}`);

    const buildSimulators = !isEmpty(filteredSimulators) ? filteredSimulators : flattenValued;
    //log.debug(`Build Simulators: ${JSON.stringify(buildSimulators)}`);

    for await (const device of buildSimulators) {
      const wdaLocalPort = await getFreePort();
      const mjpegServerPort = await getFreePort();
      const totalUtilizationTimeMilliSec = await getUtilizationTime(device.udid);
      returnedSimulators.push(
        Object.assign({
          ...device,
          wdaLocalPort,
          mjpegServerPort,
          busy: false,
          realDevice: false,
          platform: this.getDevicePlatformName(device.name),
          deviceType: 'simulator',
          host: `http://${this.pluginArgs.bindHostOrIp}:${this.hostPort}`,
          totalUtilizationTimeMilliSec: totalUtilizationTimeMilliSec,
          sessionStartTime: 0,
          derivedDataPath: this.prepareDerivedDataPath(
            this.pluginArgs.derivedDataPath,
            device.udid,
            false,
          ),
        }),
      );
    }

    return returnedSimulators;
  }

  private async getLocalSims(): Promise<Array<IDevice>> {
    try {
      const simctl = new Simctl();
      // list runtimes and log availability errors
      const list = await simctl.list();
      const runtimes = list.runtimes;
      const unAavailableRuntimes = runtimes
        .filter((runtime: any) => !runtime.isAvailable)
        .map((runtime: any) => runtime.name);
      if (unAavailableRuntimes.length > 0) {
        log.error(`The following runtimes are not available: ${unAavailableRuntimes.join(', ')}`);
      }

      const iOSSimulators = flatten(Object.values(await simctl.getDevices(null, 'iOS'))).length > 1;
      const tvSimulators = flatten(Object.values(await simctl.getDevices(null, 'tvOS'))).length > 1;

      log.debug(`iOS Simulators: ${iOSSimulators}`);
      log.debug(`tvOS Simulators: ${tvSimulators}`);

      let iosSimulators: any = [];
      let tvosSimulators: any = [];
      if (iOSSimulators) {
        iosSimulators = flatten(
          Object.values((await simctl.getDevicesByParsing('iOS')) as Array<IDevice>),
        );
      } else {
        log.info('No iOS simulators found!');
      }

      if (tvSimulators) {
        tvosSimulators = flatten(
          Object.values((await simctl.getDevicesByParsing('tvOS')) as Array<IDevice>),
        );
      } else {
        log.info('No tvOS simulators found!');
      }
      return [...iosSimulators, ...tvosSimulators];
    } catch (error) {
      log.error(error);
      return [];
    }
  }
}
