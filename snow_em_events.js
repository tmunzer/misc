//
// Copyright © 2024 Juniper Networks, Inc.  All rights reserved
//

(function loadData(
    import_set_table,
    data_source,
    import_log,
    last_success_import_time
) {
    import_set_table.addJSONColumn("data", 10000);

    // CONNECTION PROPERTIES
    var sgcConnection_sys_id = null;
    var sgcConnection_alias = null;
    var org_id = null;

    var sgcConnection_GR = new GlideRecord("sn_cmdb_int_util_service_graph_connection");
    sgcConnection_GR.addEncodedQuery("sys_scope=71710fa4dbc721505470633fd3961913");
    sgcConnection_GR.query();
    if (sgcConnection_GR.next()) {
        sgcConnection_sys_id = sgcConnection_GR.sys_id;
        sgcConnection_alias = sgcConnection_GR.connection_alias;
    }
    var connectionAlias_GR = new GlideRecord("sys_alias");
    connectionAlias_GR.get(sgcConnection_alias);
    var sgcProperties_GR = new GlideRecord("sn_cmdb_int_util_service_graph_connection_property");
    sgcProperties_GR.addEncodedQuery("sn_cmdb_int_util_service_graph_connection=" + sgcConnection_sys_id + "^property=Organization_id");
    sgcProperties_GR.query();
    if (sgcProperties_GR.next()) {
        org_id = sgcProperties_GR.value;
    }

    // SYNC PROPERTIES
    var sync_device_mac = _define_device_mac();
    var sync_device_types = _define_device_type(sync_device_mac);
    var sync_device_status = _define_device_status();
    var ci_classes = _define_ci_classes();
    var site_ids = gs.getProperty("x_jun_mist_sgc.Site_ids");

    // SYNC DATA
    var mist_devices = {};
    var mist_sites = sync_sites(connectionAlias_GR, org_id, site_ids);
    mist_devices = sync_inventory(connectionAlias_GR, org_id, site_ids, mist_sites, mist_devices, sync_device_mac, sync_device_types, ci_classes);
    mist_devices = sync_devices(connectionAlias_GR, org_id, site_ids, mist_sites, mist_devices, sync_device_mac, sync_device_types, ci_classes);

    // Insert the devices into the import_set_table
    for (var serial in mist_devices) {
        var device = mist_devices[serial];
        if (sync_device_status.claimed || device.attributes.indexOf("assigned") > -1) {
            if (sync_device_status.assigned || device.attributes.indexOf("discovered") > -1) {
                var map = {};
                device.attributes = device.attributes.join(',');
                map["u_data"] = JSON.stringify(device);
                import_set_table.insert(map);
            }
        }
    }

})(import_set_table, data_source, import_log, last_success_import_time);

function _define_ci_classes() {
    // Define the CMDB CI Classes that will be used depending on the device type
    var ci_classes = {
        ci_class_ap: "cmdb_ci_wap_network",
        ci_class_switch: "cmdb_ci_ip_switch",
        ci_class_ssr: "cmdb_ci_ip_router",
        ci_class_srx: "cmdb_ci_ip_router"
    };
    try {
        ci_classes.ci_class_ssr = gs.getProperty("x_jun_mist_sgc.CI_Class_SSR").split(" ")[0];
    } catch (e) {
        gs.warn("Unable to get the SSR CI Class from the property x_jun_mist_sgc.CI_Class_SSR. Using default CI Class cmdb_ci_ip_router");
    }
    try {
        ci_classes.ci_class_srx = gs.getProperty("x_jun_mist_sgc.CI_Class_SRX").split(" ")[0];
    } catch (e) {
        gs.warn("Unable to get the SRX CI Class from the property x_jun_mist_sgc.CI_Class_SRX. Using default CI Class cmdb_ci_ip_router");
    }
    return ci_classes;
}

function _define_device_mac() {
    // Check if a single device must be syncrhonised (return the device mac), or all the devices (returns null)
    var sync_device_mac = null;
    var queue_GR = new GlideRecord("x_jun_mist_sgc_synchronization_queue");
    queue_GR.addQuery("data_source", "cac70009db59f9105470633fd396195d");
    queue_GR.query();
    if (queue_GR.next()) {
        sync_device_mac = queue_GR.device_mac;
        queue_GR.deleteRecord();
    }
    return sync_device_mac;
}

function _define_device_status() {
    var sync_device_status = {
        claimed: false,
        assigned: false
    };
    var sync_device_status_property = gs.getProperty("x_jun_mist_sgc.Sync_Device_Status");
    if (sync_device_status_property.toLowerCase() === "claimed") {
        sync_device_status.claimed = true;
        sync_device_status.assigned = true;
    } else if (sync_device_status_property.toLowerCase() === "assigned") {
        sync_device_status.assigned = true;
    }
    return sync_device_status;
}

function _define_device_type(sync_device_mac) {
    // Define the type of devices to sync, based on the SGC Properties and if sync_device_mac is defined
    // Return a list of device types
    var sync_device_types = [];
    if (sync_device_mac != null) {
        sync_device_types = ["all"];
    } else {
        // Sync
        var sync_aps = gs.getProperty("x_jun_mist_sgc.Sync_Aps");
        var sync_switches = gs.getProperty("x_jun_mist_sgc.Sync_Switches");
        var sync_gateways = gs.getProperty("x_jun_mist_sgc.Sync_Gateways");
        if (sync_aps == "true") sync_device_types.push("ap");
        if (sync_switches == "true") sync_device_types.push("switch");
        if (sync_gateways == "true") sync_device_types.push("gateway");
        if (sync_device_types.length == 0 || sync_device_types.length == 3) sync_device_types = ["all"];
    }
    return sync_device_types;
}

/****************************************************
 *
 * SITES SYNC PROCESSING
 *
 */
function sync_sites(connectionAlias_GR, org_id, site_ids) {
    // Define Output
    var mist_sites = {};
    // Define Inputs
    var ds_sites_inputs = {};
    ds_sites_inputs["connection_alias"] = connectionAlias_GR;
    ds_sites_inputs["org_id"] = org_id;
    // Get all sites
    try {
        // Execute Data Stream Action.
        var ds_sites_result = sn_fd.FlowAPI.getRunner()
            .datastream("x_jun_mist_sgc.mist_listorgsites_datastream")
            .inForeground()
            .withInputs(ds_sites_inputs)
            .run();
        var stream_sites = ds_sites_result.getDataStream();
        // Process each item in the data stream
        while (stream_sites.hasNext()) {
            var site_item = stream_sites.next();

            if (site_ids.length == 0 || site_ids.indexOf(site_item.id) > -1) {
                mist_sites[site_item.id] = site_item;
            }
        }
    } catch (ex) {
        var site_error_message = ex.message;
        gs.error("sync_sites: " + site_error_message);
    } finally {
        if (stream_sites) {
            stream_sites.close();
        }
    }
    return mist_sites;
}


/****************************************************
 *
 * INVENTORY SYNC PROCESSING
 *
 */
function sync_inventory(connectionAlias_GR, org_id, site_ids, mist_sites, mist_devices, sync_device_mac, sync_device_types, ci_classes) {
    // Define Inputs
    var ds_inventory_inputs = {};
    ds_inventory_inputs["connection_alias"] = connectionAlias_GR;
    ds_inventory_inputs["org_id"] = org_id;
    ds_inventory_inputs["vc"] = true;

    sync_device_types.forEach(function(device_type) {
        if (sync_device_mac != null) ds_inventory_inputs["device_mac"] = sync_device_mac;
        if (device_type != "all") ds_inventory_inputs["type"] = device_type;
        var i = 0;
        try {
            // Execute Data Stream Action.
            var ds_result = sn_fd.FlowAPI.getRunner()
                .datastream("x_jun_mist_sgc.mist_listorgdeviceinventory_datastream")
                .inForeground()
                .withInputs(ds_inventory_inputs)
                .run();
            var stream_devices = ds_result.getDataStream();
            // Process each item in the data stream
            while (stream_devices.hasNext()) {
                // Get a single item from the data stream.
                var ds_input = stream_devices.next();
                var device_item = JSON.parse(ds_input.payload);
                // only process if 
                // * device not assigned 
                // * device assigned and no sites filter
                // * device assigned and site in sites filter
                if (device_item.site_id == null || site_ids.length == 0 || site_ids.indexOf(device_item.site_id) > -1) {
                    // Use the item.
                    var processed_device = _inventory_processing(device_item, mist_sites, ci_classes);
                    i++;
                    mist_devices[processed_device.serial] = processed_device;
                }
            }
        } catch (ex) {
            gs.error("sync_inventory: " + ex.message);
        } finally {
            if (stream_devices) {
                stream_devices.close();
            }
        }
    });
    return mist_devices;
}


function _inventory_processing(device_item, mist_sites, ci_classes) {
    var processed_device = _init_device(device_item, mist_sites, ci_classes);
    if (device_item.site_id != null) processed_device = _add_attribute(processed_device, "assigned");
    return processed_device;
}


/****************************************************
 *
 * DEVICES SYNC PROCESSING
 *
 */
function sync_devices(connectionAlias_GR, org_id, site_ids, mist_sites, mist_devices, sync_device_mac, sync_device_types, ci_classes) {
    // Get devices
    // ha_peer_mac is a workaround to get the gateway 2node mac until the API is fixed
    var fields = [
        "id",
        "org_id",
        "site_id",
        "map_id",
        "model",
        "type",
        "mac",
        "vc_mac",
        "serial",
        "name",
        "hostname",
        "created_time",
        "last_seen",
        "status",
        "version",
        "module_stats",
        "module_stat",
        "module2_stat",
        "ip_stat",
        "if_stat",
        "if2_stat",
        "lldp_stat",
        "port_stat",
        "ip",
        "is_ha",
        "ha_peer_mac",
        "clients"
    ];
    // Define Inputs
    var ds_devices_inputs = {};
    ds_devices_inputs["connection_alias"] = connectionAlias_GR;
    ds_devices_inputs["org_id"] = org_id;
    ds_devices_inputs["fields"] = fields;

    if (sync_device_mac != null) {
        sync_device_types = ["all"];
        ds_devices_inputs["device_mac"] = sync_device_mac;
    } else {
        if (site_ids.length > 0) {
            ds_devices_inputs["site_id"] = site_ids;
        }
    }
    return _sync_devices(ds_devices_inputs, sync_device_types, mist_sites, mist_devices, ci_classes);
}

function _sync_devices(ds_devices_inputs, sync_device_types, mist_sites, mist_devices, ci_classes) {
    // Discriminator
    var vc_discriminator = gs.getProperty("x_jun_mist_sgc.Switch_VC_discriminator");
    var cluster_discriminator = gs.getProperty("x_jun_mist_sgc.Gatway_cluster_discriminator");

    sync_device_types.forEach(function(device_type) {
        ds_devices_inputs["type"] = device_type;
        try {
            // Execute Data Stream Action.
            var ds_result = sn_fd.FlowAPI.getRunner()
                .datastream("x_jun_mist_sgc.mist_device_datastream")
                .inForeground()
                .withInputs(ds_devices_inputs)
                .run();
            var stream_devices = ds_result.getDataStream();
            // Process each item in the data stream
            while (stream_devices.hasNext()) {
                // Get a single item from the data stream.
                var ds_input = stream_devices.next();
                try {
                    var device_item = JSON.parse(ds_input.payload);
                    // Use the item.
                    var processed_devices = [];
                    switch (device_item.type) {
                        case "ap":
                            processed_devices = _process_ap(device_item, mist_sites, mist_devices, ci_classes);
                            break;
                        case "switch":
                            processed_devices = _process_sw(device_item, vc_discriminator, mist_sites, mist_devices, ci_classes);
                            break;
                        case "gateway":
                            processed_devices = _process_gateway(device_item, cluster_discriminator, mist_sites, mist_devices, ci_classes);
                            break;
                    }

                    processed_devices.forEach(function(processed_device) {
                        mist_devices[processed_device.serial] = processed_device;
                    });
                } catch (e) {
                    gs.error("_sync_devices: " + ds_input.payload + "; " + e);
                }
            }
        } catch (ex) {
            gs.error("_sync_devices: " + ex.message);
        } finally {
            if (stream_devices) {
                stream_devices.close();
            }
        }
    });
    return mist_devices;
}


/******************************************************************************************************
 *
 * AP PROCESSING
 *
 ******************************************************************************************************/
function _process_ap(device_item, mist_sites, mist_devices, ci_classes) {
    try {
        var processed_device = _get_mist_device(device_item.serial, device_item, mist_sites, mist_devices, ci_classes);
        processed_device = _pre_processing_stats(processed_device, device_item, mist_sites);
        if (device_item.version) processed_device.version = device_item.version;
        if (device_item.uptime) processed_device.uptime = device_item.uptime;
        if (device_item.ip) processed_device.ip_address = device_item.ip;
        if (device_item.port_stat) {
            for (var interface_name in device_item.port_stat) {
                var interface_data = device_item.port_stat[interface_name];
                processed_device.interfaces.push({
                    interface_id: interface_name,
                    port_id: interface_name,
                    interface_name: interface_name,
                    status: _if_stat_interface_status(interface_data),
                });
            }
        }
        return [processed_device];
    } catch (e) {
        gs.error("_process_ap: " + JSON.stringify(device_item) + "\nError: " + e);
    }
}


/******************************************************************************************************
 *
 * SWITCH PROCESSING
 *
 ******************************************************************************************************/
function _process_sw(device_item, vc_discriminator, mist_sites, mist_devices, ci_class_switch) {
    try {
        if (device_item.model == "EX9214" || device_item.model == "VJUNOS") return _process_sw_virtual(device_item, mist_sites, mist_devices, ci_class_switch);
        else return _process_sw_physical(device_item, vc_discriminator, mist_sites, mist_devices, ci_class_switch);
    } catch (e) {
        gs.error("_process_sw: " + JSON.stringify(device_item) + "\nError: " + e);
    }
}

function _add_vc_discriminator(member, vc_discriminator) {
    try {
        if (vc_discriminator == "MAC Address") member.name += " (" + member.mac + ")";
        else if (vc_discriminator == "Serial Number") member.name += " (" + member.serial + ")";
        else member.name += " (fpc" + member.fpc_idx + ")";
        return member;
    } catch (e) {
        gs.error("_add_vc_discriminator: " + JSON.stringify(member) + "\nError: " + e);
    }
}

/*******************************************************
 * PROCESS PHYSICAL SWITCH
 *******************************************************/
function _process_sw_vc_member(device_item, module_stat, stack, mist_sites, mist_devices, ci_classes) {
    try {
        var member = _get_mist_device(module_stat.serial, device_item, mist_sites, mist_devices, ci_classes);
        member = _pre_processing_stats(member, device_item, mist_sites);
        member.stack = stack;
        member.fpc_idx = 0;
        if (stack) {
            if (module_stat.vc_role) member.stack_mode = module_stat.vc_role;
            if (module_stat.vc_state) {
                member.stack_state = module_stat.vc_state;
                // if module not present, marking it as disconnected
                if (module_stat.vc_state == "not-present") {
                    member.stack_mode = "not-present";
                    member.operational_status = 2;
                }
            }
        }
        if (module_stat.fpc_idx) member.fpc_idx = module_stat.fpc_idx;
        if (module_stat.version) member.version = module_stat.version;
        member.uptime = module_stat.uptime;
        if (device_item.if_stat) member.interfaces = _if_stat_processing(member.fpc_idx, device_item.if_stat, member.model);
        return member;

    } catch (e) {
        gs.error("_process_sw_vc_member: " + JSON.stringify(device_item) + "\nError: " + e);
    }
}

function _process_sw_physical(device_item, vc_discriminator, mist_sites, mist_devices, ci_classes) {
    var processed_devices = [];
	var fpc_ids = [];
    var stack = false;
    try {
        if (Array.isArray(device_item.module_stat)) {
            if (device_item.module_stat && device_item.module_stat.length > 1) {
                stack = true;
            }
            device_item.module_stat.forEach(function(module_stat) {
                var member = _process_sw_vc_member(device_item, module_stat, stack, mist_sites, mist_devices, ci_classes);
                if (member.stack_mode == "master" && stack) cluster_primary_mac = member.mac;
				fpc_ids.push("fpc_"+member.fpc_idx+"="+member.mac);
                processed_devices.push(member);
            });
        } else {
            var member = _process_sw_vc_member(device_item, device_item, false, mist_sites, mist_devices, ci_classes);
            processed_devices.push(member);
        }
    } catch (e) {
        gs.error("_process_sw_physical: " + JSON.stringify(device_item) + "\nError: " + e);
    }

    if (stack) {
        processed_devices.forEach(function(member) {
            if (member.serial) {
                if (member.stack_mode != "master") {
                    member.cluster_primary_mac = cluster_primary_mac;
                }
                if (member.mac != device_item.mac) {
                    member = _add_vc_discriminator(member, vc_discriminator);
                } else {
					member.attributes = Array.concat(member.attributes, fpc_ids);
				}
            }
        });
    }

    return processed_devices;
}

/*******************************************************
 * PROCESS VIRTUAL SWITCH
 *******************************************************/
function _process_sw_virtual(device_item, mist_sites, mist_devices, ci_classes) {
    try {
        var processed_device = _get_mist_device(device_item.serial, device_item, mist_sites, mist_devices, ci_classes);
        processed_device = _pre_processing_stats(processed_device, device_item, mist_sites);
        processed_device.fpc_idx = 0;

        if (device_item.version) processed_device.version = device_item.version;

        if (device_item.module_stat) {
            device_item.module_stat.forEach(function(module_stat) {
                if (module_stat.fpc_idx) processed_device.fpc_idx = module_stat.fpc_idx;
                if (module_stat.version) processed_device.version = module_stat.version;
            });
        }

        if (device_item.if_stat)
            processed_device.interfaces = _if_stat_processing(processed_device.fpc_idx, device_item.if_stat, member.model);
        return [processed_device];
    } catch (e) {
        gs.error("_process_sw_virtual " + JSON.stringify(device_item) + "\nError: " + e);
    }
}

/******************************************************************************************************
 *
 * GATEWAY PROCESSING
 *
 ******************************************************************************************************/
function _get_gateway_module_stat(device_item, node_id) {
    try {
        var module_stat = "module_stat";
        if (node_id == 1) {
            module_stat = "module2_stat";
        }
        if (Array.isArray(device_item[module_stat]) && device_item[module_stat].length > 0) return device_item[module_stat][0];
        else return {};
    } catch (e) {
        gs.error("_get_gateway_module_stat: " + JSON.stringify(device_item) + "\nError: " + e);
        return {};
    }
}

function _process_gw_cluster_node(device_item, node_id, stack, mist_sites, mist_devices, ci_classes) {
    try {
        var module_stat = _get_gateway_module_stat(device_item, node_id);
        var node = _get_mist_device(module_stat.serial, device_item, mist_sites, mist_devices, ci_classes);
        if (module_stat.vc_state) node.stack_state = module_stat.vc_state;
        if (module_stat.vc_role) node.stack_mode = module_stat.vc_role;
        else if (stack) node.stack_mode = "node_" + node_id;
        if (module_stat.version) node.version = module_stat.version;
        node.uptime = module_stat.uptime;
        return node;
    } catch (e) {
        gs.error("_process_gw_cluster_node: " + JSON.stringify(device_item) + "\nError: " + e);
        return {};
    }
}

function _add_cluster_discriminator(node, node_id, cluster_discriminator) {
    try {
        if (cluster_discriminator == "MAC Address") node.name += " (" + node.mac + ")";
        else if (cluster_discriminator == "Serial Number") node.name += " (" + node.serial + ")";
        else node.name += " (node" + node_id + ")";
        return node;
    } catch (e) {
        gs.error("_add_cluster_discriminator: " + JSON.stringify(node) + "\nError: " + e);
        return {};
    }
}

function _detect_hardware_model(module_stat) {
    try {
        if (module_stat.model === "SSR" && module_stat.hardware_model) {
            if (module_stat.hardware_model.startsWith("Juniper Networks Inc.")) {
                if (module_stat.hardware_model.indexOf("SSR") >= 0) {
                    var start_index = module_stat.hardware_model.indexOf("SSR");
                    return module_stat.hardware_model.substr(start_index).replace(")", "");
                }
            }
                return "SSR (" + module_stat.hardware_model + ")";
        } else {
            return module_stat.model;
        }
    } catch (e) {
        gs.error("_detect_hardware_model: " + JSON.stringify(module_stat) + "\nError: " + e);
    }
}

function _process_gateway(device_item, cluster_discriminator, mist_sites, mist_devices, ci_classes) {
    var processed_devices = [];
    var stack = false;
    try {
        if (device_item.is_ha == true) {
            stack = true;
        }
        // member 0
        var node_0 = _process_gw_cluster_node(device_item, 0, stack, mist_sites, mist_devices, ci_classes);
        node_0 = _pre_processing_stats(node_0, device_item, mist_sites);
        node_0.stack = stack;
        node_0.fpc_idx = 0;
        node_0.model = _detect_hardware_model(device_item.module_stat[0]);
        node_0.interfaces = _if_stat_processing(node_0.fpc_idx, device_item.if_stat, node_0.model);
        processed_devices.push(node_0);
    } catch (e) {
        gs.error("_process_gateway - node 0: " + JSON.stringify(device_item) + "\nError: " + e);
    }
    // member 1
    if (stack == true) {
        try {
            var node_1 = _process_gw_cluster_node(device_item, 1, stack, mist_sites, mist_devices, ci_classes);
            node_1 = _pre_processing_stats(node_1, device_item, mist_sites);
            node_1.stack = stack;
            node_1.cluster_primary_mac = node_0.mac;
            node_1.fpc_idx = 1;
            node_1.model = _detect_hardware_model(device_item.module2_stat[0]);
            node_1 = _add_attribute(node_1, "assigned");
            if (!node_1.mac) node_1.mac = device_item.ha_peer_mac;
            switch (node_1.model) {
                case "SRX300":
                    node_1.fpc_idx = 1;
                    break;
                case "SRX320":
                    node_1.fpc_idx = 3;
                    break;
                case "SRX340":
                case "SRX345":
                case "SRX380":
                    node_1.fpc_idx = 5;
                    break;
                case "SRX1500":
                    node_1.fpc_idx = 7;
                    break;
                case "SRX550M":
                    node_1.fpc_idx = 9;
                    break;
            }
            if (device_item.if2_stat) node_1.interfaces = _if_stat_processing(node_1.fpc_idx, device_item.if2_stat, node_1.model);
            else node_1.interfaces = _if_stat_processing(node_1.fpc_idx, device_item.if_stat, node_1.model);
            node_1 = _add_cluster_discriminator(node_1, "1", cluster_discriminator);
            processed_devices.push(node_1);
        } catch (e) {
            gs.error("_process_gateway - node1: " + JSON.stringify(device_item) + "; " + e);
        }
    }


    return processed_devices;
}

/****************************************************
 *
 * COMMON PROCESSING
 *
 */
function _get_ci_class(device, ci_classes) {
    try {
        if (device.type == "ap") return ci_classes.ci_class_ap;
        else if (device.type == "switch") return ci_classes.ci_class_switch;
        else if (device.type == "gateway") {
            if (device.model.toLowerCase().startsWith("srx")) return ci_classes.ci_class_srx;
            else if (device.model.toLowerCase().startsWith("vsrx")) return ci_classes.ci_class_srx;
            else if (device.model.toLowerCase().startsWith("ssr")) return ci_classes.ci_class_ssr;
            else return "cmdb_ci_ip_router";
        }
    } catch (e) {
        gs.warn("Unable to define the ci_class for the device. Using default class cmdb_ci_netgear. \nDevice: " + JSON.stringify(device) + "\nError: " + e);
    }
    return "cmdb_ci_netgear";
}

function _if_stat_interface_status(interface_data) {
    var status = 0;
    try {
        if ("up" in interface_data) {
            if (interface_data.up == true) status = 1;
            else if (interface_data.up == false) status = 2;
        }
    } catch (e) {
        gs.warn("_if_stat_interface_status " + JSON.stringify(interface_data) + "\nError: " + e);
    }
    return status;
}

function _device_status(status) {
    if (status == "connected" || status == "upgrading") return 1;
    else return 2;
}

function _ip_stat_processing(device_item, processed_device) {
    try {
        if (device_item.ip_stat) {
            processed_device.ip_address = device_item.ip_stat.ip;
            processed_device.netmask = device_item.ip_stat.netmask;
            processed_device.default_gateway = device_item.ip_stat.gateway;
            processed_device.ip_address_v6 = device_item.ip_stat.ip6;
            processed_device.netmask_v6 = device_item.ip_stat.netmask6;
            processed_device.default_gateway_v6 = device_item.ip_stat.gateway6;
        }
    } catch (e) {
        gs.error("_ip_stat_processing " + JSON.stringify(device_item) + "\nError: " + e);
    }
    return processed_device;
}

function _if_stat_processing(fpc_idx, if_stat, hardware_model) {
    var processed_if_stat = [];
    try {
        for (var interface_name in if_stat) {
            var process_interface = false;
            var interface_id = interface_name;
            if (hardware_model && hardware_model.startsWith("SSR")) {
                // Force interface processing for SSR
                process_interface = true;
            } else if (interface_name.indexOf("-") < 0) {
                // Force interface processing if internal interface (em0, fxp0, ...)
                process_interface = true;
            } else {
                var interface_fpc_idx = interface_name.split("-")[1].split("/")[0];
                if (interface_fpc_idx == fpc_idx) process_interface = true;
                interface_id = interface_name.split("-")[1].substr(2);
            }
            if (process_interface) {
                var interface_stat_in = if_stat[interface_name];
                var port_id = interface_stat_in.port_id;
                var interface_stat_out = {};

                if (interface_stat_in.ips) {
                    interface_stat_in.ips.forEach(function(ip_mask) {
                        interface_stat_out = {
                            port_id: port_id,
                            interface_name: interface_name,
                            interface_id: interface_id,
                            ip_address: "",
                            netmask: "",
                            version: 4,
                            status: _if_stat_interface_status(interface_stat_in),
                            vlan: 0,
                        };
                        interface_stat_out.ip_address = ip_mask.replace(/\/.*/, "");
                        var mask = ip_mask.replace(/.*\//, "");
                        if (interface_stat_out.ip_address.indexOf(":") > -1) {
                            interface_stat_out.ip_version = 6;
                            interface_stat_out.netmask = "/" + mask;
                        } else {
                            interface_stat_out.ip_version = 4;
                            interface_stat_out.netmask = _ipv4_netmask(mask);
                        }
                        processed_if_stat.push(interface_stat_out);
                    });
                } else {
                    interface_stat_out = {
                        port_id: port_id,
                        interface_name: interface_name,
                        interface_id: interface_id,
                        ip_address: "",
                        netmask: "",
                        version: 4,
                        status: _if_stat_interface_status(interface_stat_in),
                        vlan: 0,
                    };
                    processed_if_stat.push(interface_stat_out);
                }
            }
        }
    } catch (e) {
        gs.error("_if_stat_processing: " + JSON.stringify(if_stat) + "\nModel: " + hardware_model + "\nError: " + e);
    }
    return processed_if_stat;
}

function _ipv4_netmask(bitCount) {
    try {
        var mask = [];
        for (var j = 0; j < 4; j++) {
            var n = Math.min(bitCount, 8);
            mask.push(256 - Math.pow(2, 8 - n));
            bitCount -= n;
        }
        return mask.join(".");
    } catch (e) {
        gs.error("_ipv4_netmask: " + bitCount + "\nError: " + e);
    }
}

/****************************************************
 *
 * MIST DEVICES LIST PROCESSING
 *
 */
function _get_mist_device(device_serial, device_item, mist_sites, mist_devices, ci_classes) {
    var processed_device = mist_devices[device_serial];
    if (!processed_device) processed_device = _init_device(device_item, mist_sites, ci_classes);
    return processed_device;
}

/****************************************************
 *
 * PRE PROCESSING
 *
 */
function _pre_processing_stats(processed_device, device_item, mist_sites) {
    try {
        if (device_item.last_seen) {
            processed_device.last_seen = device_item.last_seen;
            processed_device = _add_attribute(processed_device, "discovered");
        } else processed_device.last_seen = 0;
        processed_device.uptime = device_item.uptime;
        processed_device.version = device_item.version;
        processed_device.device_id = device_item.id;
        processed_device.operational_status = _device_status(device_item.status);
        if (device_item.site_id) {
            processed_device.site_id = device_item.site_id;
            processed_device = _add_attribute(processed_device, "assigned");
        } else processed_device.site_id = "00000000-0000-0000-0000-000000000000";
        processed_device.key_values = [{
                "key": "org_id",
                "value": device_item.org_id
            },
            {
                "key": "site_id",
                "value": processed_device.site_id
            },
            {
                "key": "device_id",
                "value": device_item.id
            },
            {
                "key": "map_id",
                "value": device_item.map_id
            }
        ];
        processed_device.site = mist_sites[device_item.site_id];
        processed_device = _ip_stat_processing(device_item, processed_device);
    } catch (e) {
        gs.error("_pre_processing_stats: " + JSON.stringify(device_item) + "\nError: " + e);
    }
    return processed_device;
}

function _init_device(device_item, mist_sites, ci_classes) {
    var processed_device = {};
    try {
        processed_device.attributes = [];
        processed_device.can_partitionvlans = true;
        processed_device.can_route = true;
        processed_device.can_switch = true;
        processed_device.ci_class = _get_ci_class(device_item, ci_classes);
        processed_device.created_time = device_item.created_time;
        processed_device.default_gateway = "";
        processed_device.device_id = device_item.id;
        processed_device.discovery_proto_id = "Mist";
        processed_device.discovery_source = "SG-JuniperMIST";
        processed_device.firmware_manufacturer = "Juniper Networks";
        processed_device.vendor = "Juniper Networks";

        processed_device.model = device_item.model;
        processed_device.mac = device_item.mac;
        processed_device.serial = device_item.serial;
        if (device_item.name) processed_device.name = device_item.name;
        else processed_device.name = processed_device.mac;
        processed_device.type = device_item.type;
        processed_device.operational_status = _device_status(device_item.status);
        if (device_item.site_id) processed_device.site_id = device_item.site_id;
        else processed_device.site_id = "00000000-0000-0000-0000-000000000000";

        if (!device_item.vc_mac || device_item.vc_mac == device_item.mac) {
            processed_device = _add_attribute(processed_device, "mist_device");
        }

        processed_device.stack = false;
        processed_device.interfaces = [];
        processed_device.key_values = [{
                "key": "org_id",
                "value": device_item.org_id
            },
            {
                "key": "site_id",
                "value": processed_device.site_id
            },
            {
                "key": "device_id",
                "value": device_item.id
            },
            {
                "key": "map_id",
                "value": device_item.map_id
            }
        ];
        processed_device.site = mist_sites[device_item.site_id];

    } catch (e) {
        gs.error("_pre_processing: " + JSON.stringify(processed_device) + "\nError: " + e);
    }
    return processed_device;
}

function _add_attribute(processed_device, attribute) {
    if (processed_device.attributes.indexOf(attribute) < 0) {
        processed_device.attributes.push(attribute);
        processed_device.attributes.sort();
    }
    return processed_device;
}
