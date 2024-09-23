//
// Copyright © 2024 Juniper Networks, Inc.  All rights reserved
//
(function process( /*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
    try {
        var request_body = request.body;
        var request_data = request_body.data;
        var topic = "";
        var events = [];
        if (request_data.topic) topic = request_data.topic;
        if (request_data.events) events = request_data.events;
        if (["alarms"].indexOf(topic) >= 0) {
            var events_received = events.length;
            var events_processed = _process_webhook(events);
            if (events_processed == events_received) {
                response.setStatus(200);
                response.setBody({
                    result: "success",
                });
                //gs.debug("Response: HTTP200/success");
            } else {
                response.setStatus(500);
                response.setBody({
                    result: "Internal Server Error",
                    reason: events_processed + "/" + events_received + " event(s) processed"
                });
                gs.warn(
                    "Response: HTTP500/Internal Server Error - Please check Servicenow logs for more details"
                );
            }
        } else {
            response.setStatus(501);
            response.setBody({
                result: "Not Implemented",
                reason: topic + " topic not supported",
            });
            gs.debug(
                "Response: HTTP501/Not Implemented - " + topic + " topic not supported"
            );
        }
    } catch (e) {
        response.setStatus(500);
        response.setBody({
            result: "Internal Server Error",
            reason: e,
        });
        gs.error(e);
        gs.error("Response: HTTP500/Internal Server Error");
    }
})(request, response);

/****************************************************************************
 * Function to route the alarm webhook
 /**************************************************************************/
function _process_webhook(events) {
    var events_processed = 0;
    var events_created = 0;
    events.forEach(function(event) {
        try {
            if (event.group == "marvis") {
                new_evt_created = process_event_marvis(event);
            } else {
                new_evt_created = process_event_common(event);
            }
            if (new_evt_created > 0) {
                events_processed += 1;
                events_created += new_evt_created;
            }
        } catch (e) {
            gs.error(
                "_process_webhook: Unable to process Mist alarm: " +
                JSON.stringify(event)
            );
            gs.error(e);
        }
    });
    return events_processed;
}

/****************************************************************************
 * Common functions
 /**************************************************************************/
// mac address
function gen_mac(mac) {
    var mac_regex = /[0-9-a-f]{2}/g;
    var mac_parts = [];
    while ((part = mac_regex.exec(mac))) {
        mac_parts.push(part);
    }
    var new_mac = mac_parts.join(":");
    return new_mac;
}

function gen_correlation_id(event) {
    var alert_id = null;
    if (event.alert_id) alert_id = event.alert_id;
    else if (event.id) alert_id = event.id;
    return alert_id;
}

function gen_severity(event) {
    var severity = "3";
    switch (event.severity) {
        case "info":
            severity = "3";
            break;
        case "warn":
            severity = "4";
            break;
        case "critical":
            severity = "2";
            break;
    }
    return severity;
}

/**
 * Functions to generate case/incident data
 */
function find_cmdb_ci_netgear(mac_address) {
    var cmdb_GR = new GlideRecord("cmdb_ci_netgear");
    var query = "mac_addressSTARTSWITH" + mac_address;
    cmdb_GR.addEncodedQuery(query);
    cmdb_GR.query();
    if (cmdb_GR.next()) {
        return cmdb_GR.sys_id;
    } else {
        gs.warn("find_cmdb_ci_netgear: No CI found for MAC Address " + mac_address);
        return null;
    }
}
/****************************************************************************
 * Functions to process infrastructure and security alarms
 /**************************************************************************/
function _generate_event_common(event) {
    try {
        var generated_events = [];
        var status = "New";
        var closed_events = [
            "_connected",
            "_reconnected",
            "_success",
            "_up",
            "_plugged",
            "_normal",
        ];

        // Try to detect if it's a closing event
        closed_events.forEach(function(e) {
            if (event.type.endsWith(e)) {
                status = "Closing";
            }
        });

        // Process each AP/Switch/Gateway releated to the alarm
        var devices = [];
        if (event.aps) {
            var i;
            for (i = 0; i < event.aps.length; i++) {
                devices.push({
                    type: "AP",
                    mac: gen_mac(event.aps[i]),
                    hostname: event.hostnames[i],
                    status: status,
                    description: "",
                    cmdb_ci: find_cmdb_ci_netgear(gen_mac(event.aps[i])),
                });
            }
        } else if (event.switches) {
            for (i = 0; i < event.switches.length; i++) {
                devices.push({
                    type: "Switch",
                    mac: gen_mac(event.switches[i]),
                    hostname: event.hostnames[i],
                    status: status,
                    description: "",
                    cmdb_ci: find_cmdb_ci_netgear(gen_mac(event.switches[i])),
                });
            }
        } else if (event.gateways) {
            for (i = 0; i < event.switches.length; i++) {
                devices.push({
                    type: "Gateway",
                    mac: gen_mac(event.gateways[i]),
                    hostname: event.hostnames[i],
                    status: status,
                    description: "",
                    cmdb_ci: find_cmdb_ci_netgear(gen_mac(event.gateways[i])),
                });
            }
        }

        // Generate the Site string if field is present
        var site_str = "";
        if (event.site_name) {
            site_str = "[" + event.site_name + "] ";
        }

        // for each device, generate the description
        devices.forEach(function(device) {
            device.description =
                site_str +
                event.type +
                " - " +
                device.type +
                " " +
                device.hostname +
                " (MAC: " +
                device.mac +
                ")";
            generated_events.push(device);
        });
    } catch (e) {
        gs.error("_generate_event_common" + e);
    }
    return devices;
}

/**
 * Functions to process infrastructure and security alarms
 */
function process_event_common(event) {
    var evt_created = 0;
    var devices = _generate_event_common(event);
    var severity = gen_severity(event);

    devices.forEach(function(device) {
        try {
            var evt = new GlideRecord("em_event");
            evt.initialize();
            evt.source = "Juniper Mist";
            evt.node = device.hostname;
            evt.event_class = "Juniper Mist";
            evt.additional_info = JSON.stringify(event);
            evt.description = device.description;
            evt.severity = severity;
            evt.type = event.type.replace("_", " ");
            evt.status = device.status;
            evt.cmdb_ci = device.cmdb_ci;
            evt.user = gs.getUserID();
            evt.insert();
            evt_created += 1;
        } catch (e) {
            gs.error("process_event_common" + e);
        }
    });

    return evt_created;
}

/****************************************************************************
 * Functions to process marvis alarms
 /**************************************************************************/
function _generate_event_marvis(event) {
    var generated_events = [];
    var entities = [];
    try {
        // Process each AP/Switch/Gateway releated to the alarm
        if (event.impacted_entities) {
            event.impacted_entities.forEach(function(entity) {
                var entity_event = {
                    type: entity.entity_type,
                    mac: entity.entity_mac,
                    hostname: entity.entity_name,
                    additional_info: "",
                    description: "",
                    cmdb_ci: find_cmdb_ci_netgear(gen_mac(entity.entity_mac)),
                };
                var tmp = [];
                for (var key in entity) {
                    if (!key.startsWith("entity_")) {
                        tmp.push(key + ": " + entity[key]);
                    }
                }
                if (tmp.length > 0) {
                    entity_event.additional_info = " - " + tmp.join(", ");
                }
                entities.push(entity_event);
            });
        }

        // Generate the Site string if field is present
        var site_str = "";
        if (event.site_name) {
            site_str = "[" + event.site_name + "] ";
        }

        // for each device, generate the description
        entities.forEach(function(entity) {
            entity.description =
                site_str +
                event.type +
                " - " +
                entity.type +
                " " +
                entity.hostname +
                " (MAC: " +
                entity.mac +
                ")" +
                entity.additional_info;
            generated_events.push(entity);
        });
    } catch (e) {
        gs.error("_generate_event_marvis" + e);
    }
    return entities;
}

function process_event_marvis(event) {
    var evt_created = 0;
    var entities = _generate_event_marvis(event);
    var severity = gen_severity(event);
    var status = "New";
    if (event.status == "resolved") status = "Closing";

    entities.forEach(function(entity) {
        try {
            var evt = new GlideRecord("em_event");
            evt.initialize();
            evt.source = "Juniper Mist";
            evt.node = device.hostname;
            evt.event_class = "Juniper Mist";
            evt.additional_info = JSON.stringify(event);
            evt.description = entity.description;
            evt.severity = severity;
            evt.type = event.type.replace("_", " ");
            evt.status = status;
            evt.cmdb_ci = entity.cmdb_ci;
            evt.user = gs.getUserID();
            evt.insert();
            evt_created += 1;
        } catch (e) {
            gs.error("process_event_marvis" + e);
        }
    });

    return evt_created;
}
