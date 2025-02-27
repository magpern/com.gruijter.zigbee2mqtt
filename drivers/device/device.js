/* eslint-disable camelcase */
/* eslint-disable no-await-in-loop */
/*
Copyright 2023, Robin de Gruijter (gruijter@hotmail.com)

This file is part of com.gruijter.zigbee2mqtt.

com.gruijter.zigbee2mqtt is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

com.gruijter.zigbee2mqtt is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with com.gruijter.zigbee2mqtt.  If not, see <http://www.gnu.org/licenses/>.
*/

'use strict';

const { Device } = require('homey');
const util = require('util');
const { capabilityMap, mapProperty } = require('../../capabilitymap');

const setTimeoutPromise = util.promisify(setTimeout);

class MyDevice extends Device {

	async onInit() {
		try {
			this.store = this.getStore();
			this.settings = await this.getSettings();

			await this.registerHomeyEventListeners();
			await this.connectBridge();
			await this.checkChangedOrDeleted();
			await this.migrate();
			await this.registerListeners();
			await this.getStatus({ state: '' }, 'appInit');

			this.restarting = false;
			this.setAvailable();
			this.log(this.getName(), 'has been initialized');
		} catch (error) {
			this.error(error);
			this.setUnavailable(error);
			this.restarting = false;
			this.restartDevice(60 * 1000).catch(this.error);
		}
	}

	async onUninit() {
		this.log('Device unInit', this.getName());
		this.destroyListeners();
		await setTimeoutPromise(2000);	// wait 2 secs
	}

	async onAdded() {
		this.log('Device added', this.getName());
		if (this.getClass !== this.getSettings().homeyclass)	{
			this.log(`setting new Class for ${this.getName()}`, this.getSettings().homeyclass);
			await this.setClass(this.getSettings().homeyclass).catch(this.error);
		}
		await this.setCapabilityUnits();
	}

	async onSettings({ newSettings, changedKeys }) { 	// oldSettings changedKeys
		this.log('Settings changed', newSettings);
		if (changedKeys.includes('homeyclass')) {
			this.log(`setting new Class for ${this.getName()}`, this.getClass(), this.getSettings().homeyclass);
			await this.setClass(newSettings.homeyclass).catch(this.error);
		}
		this.restartDevice(1000).catch(this.error);
	}

	async onDeleted() {
		if (this.bridge && this.bridge.client) this.destroyListeners();
		this.log('Device deleted', this.getName());
	}

	async restartDevice(delay) {
		if (this.bridge && this.bridge.client && this.bridge.client.connected) this.destroyListeners();
		if (this.restarting) return;
		this.restarting = true;
		// if (this.client) await this.client.end();
		const dly = delay || 1000 * 5;
		this.log(`Device will restart in ${dly / 1000} seconds`);
		// this.setUnavailable('Device is restarting');
		await setTimeoutPromise(dly);
		this.onInit();
	}

	async migrate() {
		try {
			this.log(`checking device migration for ${this.getName()}`);
			// check and repair incorrect capability(order)
			if (!this.bridge || !this.bridge.devices) return;
			const [deviceInfo] = this.bridge.devices.filter((dev) => dev.ieee_address === this.settings.uid);
			const { capUnits } = mapProperty(deviceInfo);
			const correctCaps = mapProperty(deviceInfo).caps;
			let capsChanged = false;

			// store the capability states before migration
			const sym = Object.getOwnPropertySymbols(this).find((s) => String(s) === 'Symbol(state)');
			const state = this[sym];

			for (let index = 0; index < correctCaps.length; index += 1) {
				const caps = this.getCapabilities();
				const newCap = correctCaps[index];
				if (caps[index] !== newCap) {
					this.setUnavailable('Device is migrating. Please wait!');
					capsChanged = true;
					// remove all caps from here
					for (let i = index; i < caps.length; i += 1) {
						this.log(`removing capability ${caps[i]} for ${this.getName()}`);
						await this.removeCapability(caps[i])
							.catch((error) => this.log(error));
						await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
					}
					// add the new cap
					this.log(`adding capability ${newCap} for ${this.getName()}`);
					await this.addCapability(newCap);
					// restore capability state
					if (state[newCap]) this.log(`${this.getName()} restoring value ${newCap} to ${state[newCap]}`);
					// else this.log(`${this.getName()} has gotten a new capability ${newCap}!`);
					if (state[newCap] !== undefined) this.setCapability(newCap, state[newCap]);
					await setTimeoutPromise(2 * 1000); // wait a bit for Homey to settle
				}
				if (capsChanged) {
					await this.setStoreValue('capUnits', capUnits);
					await this.setCapabilityUnits();
				}
			}
		} catch (error) {
			this.error(error);
		}
	}

	async setCapabilityUnits() {
		try {
			this.log(`setting Capability Units for ${this.getName()}`);
			this.setUnavailable('Device is migrating. Please wait!');
			const { capUnits } = this.store;
			const capUnitsArray = Object.entries(capUnits);
			for (let index = 0; index < capUnitsArray.length; index += 1) {
				if (capUnitsArray[index][1] && capUnitsArray[index][1][0]) {
					this.log('Migrating units for', capUnitsArray[index][0], capUnitsArray[index][1]);
					const capOptions = {
						units: { en: capUnitsArray[index][1][0] },
						// title: { en: capUnitsArray[index][1][1] },
						// decimals: dec,
					};
					await this.setCapabilityOptions(capUnitsArray[index][0], capOptions).catch(this.error);
					await setTimeoutPromise(2 * 1000);
				}
			}
			this.restartDevice(1000).catch(this.error);
		} catch (error) {
			this.error(error);
		}
	}

	setCapability(capability, value) {
		if (this.hasCapability(capability) && value !== undefined) {
			this.setCapabilityValue(capability, value)
				.catch((error) => {
					this.log(error, capability, value);
				});
		}
	}

	setSetting(setting, value) {
		if (this.settings && this.settings[setting] !== value) {
			const settings = {};
			settings[setting] = value;
			this.log('New setting:', settings);
			this.setSettings(settings, value)
				.catch((error) => {
					this.log(error, setting, value);
				});
		}
	}

	async getStatus(payload, source) {
		if (!this.bridge || !this.bridge.client || !this.bridge.client.connected) return Promise.reject(Error('Bridge is not connected'));
		const pl = payload || { state: '' };
		await this.bridge.client.publish(`${this.deviceTopic}/get`, JSON.stringify(pl));
		this.log(`${JSON.stringify(pl)} sent by ${source}`);
		return Promise.resolve(true);
	}

	async setCommand(payload, source) {
		if (!this.bridge || !this.bridge.client || !this.bridge.client.connected) return Promise.reject(Error('Bridge is not connected'));
		await this.bridge.client.publish(`${this.deviceTopic}/set`, JSON.stringify(payload));
		this.log(`${JSON.stringify(payload)} sent by ${source}`);
		return Promise.resolve(true);
	}

	async checkChangedOrDeleted() {
		if (!this.bridge || !this.bridge.devices) return;
		const [deviceInfo] = this.bridge.devices.filter((dev) => dev.ieee_address === this.settings.uid);
		// check deleted
		if (!deviceInfo) {
			this.error('device was deleted in Zigbee2MQTT', this.settings.friendly_name);
			this.setUnavailable('device went missing in Zigbee2MQTT');
			throw Error('device went missing in Zigbee2MQTT');
		}
		// check for name change
		if (deviceInfo.friendly_name !== this.settings.friendly_name) {
			this.log('device was renamed in Zigbee2MQTT', this.settings.friendly_name, deviceInfo.friendly_name);
			this.setSettings({ friendly_name: deviceInfo.friendly_name });
			this.restartDevice(1000).catch(this.error);
		}
	}

	async connectBridge() {
		try {
			await setTimeoutPromise(5000);
			const bridgeDriver = this.homey.drivers.getDriver('bridge');
			await bridgeDriver.ready(() => null);
			if (bridgeDriver.getDevices().length < 1) throw Error('The source bridge device is missing in Homey.');
			const bridge = bridgeDriver.getDevice({ id: this.settings.bridge_uid });
			if (!bridge || !bridge.client) { throw Error('Cannot connect to source bridge device in Homey.'); }
			this.bridge = bridge;

			this.deviceTopic = `${bridge.settings.topic}/${this.settings.friendly_name}`;
			const handleMessage = async (topic, message) => {
				try {
					if (message.toString() === '') return;
					const info = JSON.parse(message);
					// Map the incoming value to a capability or setting
					if (topic.includes(this.deviceTopic)) {
						// console.log(`${this.getName()} update:`, info);
						// this.setAvailable();
						Object.entries(info).forEach((entry) => {
							const mapFunc = capabilityMap[entry[0]];
							if (!mapFunc) return;	// not included in Homey maping
							const capVal = mapFunc(entry[1]);
							this.setCapability(capVal[0], capVal[1]);
						});
					}

				} catch (error) {
					this.error(error);
				}
			};
			this.handleMessage = handleMessage;

			const subscribeTopics = async () => {
				try {
					this.log(`Subscribing to ${this.deviceTopic}`);
					await this.bridge.client.subscribe([`${this.deviceTopic}`]); // device state updates
					this.log(`${this.getName()} mqtt subscriptions ok`);
				} catch (error) {
					this.error(error);
				}
			};
			this.subscribeTopics = subscribeTopics;

			this.log('connecting to Bridge MQTT');
			this.bridge.client
				.on('connect', this.subscribeTopics)
				.on('message', this.handleMessage);
			if (this.bridge.client.connected) await subscribeTopics();
			return Promise.resolve(true);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	// remove listeners
	destroyListeners() {
		this.log('removing listeners', this.getName());
		this.bridge.client.removeListener('connect', this.subscribeTopics);
		this.bridge.client.removeListener('message', this.handleMessage);
		if (this.eventListenerDeviceListUpdate) this.homey.removeListener('devicelistupdate', this.eventListenerDeviceListUpdate);
		if (this.eventListenerBridgeOffline) this.homey.removeListener('bridgeoffline', this.eventListenerBridgeOffline);
	}

	// register homey event listeners
	async registerHomeyEventListeners() {
		if (this.eventListenerDeviceListUpdate) this.homey.removeListener('devicelistupdate', this.eventListenerDeviceListUpdate);
		this.eventListenerDeviceListUpdate = async () => {
			// console.log('devicelist update event received');
			this.checkChangedOrDeleted().catch(this.error);
		};
		this.homey.on('devicelistupdate', this.eventListenerDeviceListUpdate);

		if (this.eventListenerBridgeOffline) this.homey.removeListener('bridgeoffline', this.eventListenerBridgeOffline);
		this.eventListenerBridgeOffline = async (offline) => {
			// console.log('bridgeOffline event received');
			if (offline) {
				this.setUnavailable('Bridge is offline').catch(this.error);
				this.bridgeOffline = true;
			}	else {
				if (this.bridgeOffline) this.restartDevice(1000).catch(this.error);
				this.bridgeOffline = false;
			}
		};
		this.homey.on('bridgeoffline', this.eventListenerBridgeOffline);
	}

	// register capability listeners for settable commands
	registerListeners() {
		try {
			if (this.listenersSet) return true;
			// this.log('registering listeners');
			// capabilityListeners will be overwritten, so no need to unregister them

			const capArray = Object.entries(capabilityMap);
			capArray.forEach((map) => {
				const mapFunc = map[1];
				if (mapFunc().length > 2 && this.getCapabilities().includes(mapFunc()[0])) {	// capability setting is mapped and present in device
					this.log(`${this.getName()} adding capability listener ${mapFunc()[0]}`);
					this.registerCapabilityListener(mapFunc()[0], (val) => {
						const command = mapFunc(val)[2];
						this.setCommand(command, 'app').catch(this.error);
					});
				}
			});

			// this.registerMultipleCapabilityListener(['charge_target_slow', 'charge_target_fast'], async (values) => {
			// 	const slow = Number(values.charge_target_slow) || Number(this.getCapabilityValue('charge_target_slow'));
			// 	const fast = Number(values.charge_target_fast) || Number(this.getCapabilityValue('charge_target_fast'));
			// 	const targets = { slow, fast };
			// 	this.setChargeTargets(targets, 'app').catch(this.error);
			// }, 10000);

			this.listenersSet = true;
			return Promise.resolve(true);
		} catch (error) {
			return Promise.reject(error);
		}
	}
}

module.exports = MyDevice;

/*
{
	battery: 100,
	battery_low: false,
	contact: true,
	linkquality: 25,
	tamper: false,
	voltage": 3000
}

{
	child_lock: "UNLOCK",
	current: 0,
	energy: 7.12,
	indicator_mode: "off/on",
	linkquality: 218,
	power: 0,
	power_outage_memory: "restore",
	state: "ON",
	update: { installed_version: 192, latest_version: 192, state: idle },
	voltage: 232
}

*/
