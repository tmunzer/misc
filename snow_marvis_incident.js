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
        if (topic == "alarms") {
            var result = process_alarms(events);
            if (result.created == result.required) {
                response.setStatus(200);
                response.setBody({
                    "result": "success"
                });
                //gs.info("Response: HTTP200/success");
            } else {
                response.setStatus(500);
                response.setBody({
                    "result": "Internal Server Error",
                    "reason": result.created + "/" + result.required + "incident(s) created",
                    "details": result.messages
                });
                gs.warn("Response: HTTP500/Internal Server Error - Please check Servicenow logs for more details");
            }
        } else {
            response.setStatus(501);
            response.setBody({
                "result": "Not Implemented",
                "reason": topic + " topic not supported"
            });
            gs.warn("Response: HTTP501/Not Implemented - " + topic + " topic not supported");
        }

    } catch (e) {
        response.setStatus(500);
        response.setBody({
            "result": "Internal Server Error",
            "reason": JSON.stringify(e)
        });
        gs.error(e);
        gs.error("Response: HTTP500/Internal Server Error");
    }
})(request, response);

/**
 * Function to process the alarm webhook
 */
function process_alarms(events) {
    var tickets_needed = 0;
    var tickets_created = 0;
    var error_messages = [];
    var ticket_sys_id = null;
    events.forEach(function(event) {
        try {
            if (event.group == "marvis") {
                var impacted_entities = event.impacted_entities;
                if (impacted_entities) {
                    impacted_entities.forEach(function(entity) {
                        tickets_needed += 1;
                        result = gen_ticket(event, entity);
                        if (result.status == true && result.data) {
                            tickets_created += 1;
                        } else if (result.status == false) {
                            error_messages.push(result.data);
                        }
                    });
                } else {
                    tickets_needed += 1;
                    result = gen_ticket(event, null);
                    if (result.status == true && result.data) {
                        tickets_created += 1;
                    } else if (result.status == false) {
                        error_messages.push(result.data);
                    }
                }
            } else {
                gs.warn("process_alarms: received alarm for unsupported group " + event.group);
            }
        } catch (e) {
            gs.error("process_alarms: Unable to process Mist alarm: " + JSON.stringify(event));
            gs.error(e);
        }
    });
    return {
        required: tickets_needed,
        created: tickets_created,
        messages: error_messages
    };
}

/**
 * Functions to generate case/incident data
 */
function find_cmdb_ci_netgear(entity) {
    var mac = gen_mac(entity.entity_mac);
    var cmdb_GR = new GlideRecord("cmdb_ci_netgear");
    cmdb_GR.addEncodedQuery("mac_addressSTARTSWITH" + GlideStringUtil.escapeQueryTermSeparator(mac));
    cmdb_GR.query();
    if (cmdb_GR.next()) {
        return cmdb_GR.sys_id;
    } else {
        gs.warn("find_cmdb_ci_netgear: No CI found for MAC Address " + mac);
        return null;
    }
}

function find_cmdb_ci_ni_site(site_id) {
    var cmdb_GR = new GlideRecord("cmdb_ci_ni_site");
    cmdb_GR.addEncodedQuery("site_identifierSTARTSWITH" + GlideStringUtil.escapeQueryTermSeparator(site_id));
    cmdb_GR.query();
    if (cmdb_GR.next()) {
        return cmdb_GR.sys_id;
    } else {
        gs.warn("find_cmdb_ci_ni_site: No CI found for Site ID " + site_id);
        return null;
    }
}

// mac address
function gen_mac(mac) {
    var mac_regex = /[0-9-a-f]{2}/g;
    var mac_parts = [];
    while (part = mac_regex.exec(mac)) {
        mac_parts.push(part);
    }
    var new_mac = mac_parts.join(":");
    return new_mac;
}

function gen_correlation_id(event) {
    var alert_id = null;
    if (event.alert_id) alert_id = event.alert_id;
    return alert_id;
}

function define_severity(event_type) {
    /**
     * impact:
     * - 3 = low
     * - 2 = medium
     * - 1 = high
     * - 0 = use the severity from the Mist event
     * 
     * urgency:
     * - 3 = low
     * - 2 = medium
     * - 1 = high
     */
    var event_type_settings = {
        "bad_cable": {
            "enabled": true,
            "impact": 0,
            "urgency": 2
        },
        "insufficient_coverage": {
            "enabled": true,
            "impact": 0,
            "urgency": 3
        },
        "dhcp_failure": {
            "enabled": true,
            "impact": 0,
            "urgency": 1
        },
        "health_check_failed": {
            "enabled": true,
            "impact": 0,
            "urgency": 1
        },
        "non_compliant": {
            "enabled": true,
            "impact": 0,
            "urgency": 2
        },
        "port_flap": {
            "enabled": true,
            "impact": 0,
            "urgency": 3
        },
        "authentication_failure": {
            "enabled": true,
            "impact": 0,
            "urgency": 1
        },
        "insufficient_capacity": {
            "enabled": true,
            "impact": 0,
            "urgency": 3
        },
        "switch_stp_loop": {
            "enabled": true,
            "impact": 0,
            "urgency": 1
        },
        "missing_vlan": {
            "enabled": true,
            "impact": 0,
            "urgency": 1
        },
        "gw_negotiation_mismatch": {
            "enabled": true,
            "impact": 0,
            "urgency": 3
        },
        "dns_failure": {
            "enabled": true,
            "impact": 0,
            "urgency": 1
        },
        "gw_bad_cable": {
            "enabled": true,
            "impact": 0,
            "urgency": 2
        },
        "vpn_path_down": {
            "enabled": true,
            "impact": 0,
            "urgency": 1
        },
        "arp_failure": {
            "enabled": true,
            "impact": 0,
            "urgency": 1
        },
        "ap_bad_cable": {
            "enabled": true,
            "impact": 0,
            "urgency": 2
        },
        "negotiation_mismatch": {
            "enabled": true,
            "impact": 0,
            "urgency": 2
        },
        "ap_offline": {
            "enabled": true,
            "impact": 0,
            "urgency": 2
        },
        "port_stuck": {
            "enabled": true,
            "impact": 0,
            "urgency": 2
        },
        "bad_wan_uplink": {
            "enabled": true,
            "impact": 0,
            "urgency": 2
        },
        "wan_device_problem": {
            "enabled": true,
            "impact": 0,
            "urgency": 1
        }
    };
    if (event_type_settings[event_type]) {
        return event_type_settings[event_type];
    }
    return null;
}

function gen_priority(event) {
    var priority = {
        urgency: 2,
        impact: 0,
        enabled: false
    };

    var marvis_event = define_severity(event.type);
    if (marvis_event) { // if this event type has specific configuration
        priority.urgency = marvis_event.urgency;
        priority.impact = marvis_event.impact;
        priority.enabled = marvis_event.enabled;
    } else { // otherwise use the default configuration
        priority.urgency = 2;
        priority.impact = 0;
        priority.enabled = true;
    }

    // if impact is configured to be defined by Mist
    if (priority.impact == 0) {
        priority.impact = gen_impact(event);
    }
    return priority;
}

function gen_impact(event) {
    var impact = 2;
    switch (event.severity) {
        case "critical":
            impact = 1;
            break;
        case "warn":
            impact = 2;
            break;
        case "info":
            impact = 3;
            break;
    }
    return impact;
}

function gen_cause(event) {
    var cause = null;
    if (event.root_cause) cause = event.root_cause;
    return cause;
}

function gen_short_description(event) {
    var short_description = "";
    if (event.site_name) short_description = "[" + event.site_name + "] ";
    if (event.type) short_description += event.type;
    return short_description;
}

function gen_status(event) {
    var status = 1;
    if (event.status == "resolved") status = 6;
    return status;
}

function gen_description(event, entity) {
    var excluded_fields = [
        "alert_id",
        "details",
        "email_content",
        "id",
        "impacted_entities",
        "org_id",
        "org_name",
        "root_cause",
        "site_id",
        "site_name",
        "status",
        "suggestion",
        "timestamp",
        "type",
    ];
    var description = "";
    if (event.org_name) description = "Organization \"" + event.org_name + "\" (id: " + event.org_id + ")\n";
    if (event.site_name) description += "Site \"" + event.site_name + "\" (id: " + event.site_id + ")\n";
    if (description != "") description += "\n";
    if (event.type) description += "Type: " + event.type.replace(/_/g, " ") + "\n";
    if (event.root_cause) description += "Root Cause: " + event.root_cause.replace(/_/g, " ") + "\n";
    if (event.suggestion) description += "Suggestion: " + event.suggestion.replace(/_/g, " ") + "\n";

    if (entity) {
        description += "\nImpacted Entity:\n";
        for (var entity_key in entity) {
            description += entity_key.replace(/_/g, " ") + ": " + entity[entity_key] + "\n";
        }
    }

    if (description != "") description += "\n";
    for (var event_key in event) {
        if (excluded_fields.indexOf(event_key) < 0) {
            var text_key = event_key.replace(/_/g, " ");
            if (Array.isArray(event[event_key])) {
                description += text_key + ": " + event[event_key].join(", ") + "\n";
            } else {
                description += text_key + ": " + event[event_key] + "\n";
            }
        }
    }
    return description;
}


/**
 * Functions to generate case/incident 
 */

function gen_ticket(event, entity) {
    var data = {};
    var priority = gen_priority(event);
    if (priority.enabled == 1) {
        data.status = gen_status(event);
        data.impact = priority.impact;
        data.urgency = priority.urgency;
        data.correlation_id = gen_correlation_id(event);
        data.cause = gen_cause(event);
        data.short_description = gen_short_description(event);
        data.description = gen_description(event, entity);

        if (!entity || ["ap", "switch", "gateway"].indexOf(entity.entity_type) < 0) {
            data.sys_id = find_cmdb_ci_ni_site(event.site_id);
        } else {
            data.sys_id = find_cmdb_ci_netgear(entity);
        }

        return {
            status: true,
            data: save_incident(data)
        };
    } else {
        var message = "Marvis Action " + event.type + " is disabled";
        gs.warn(message);
        return {
            status: false,
            data: message
        };
    }
}

/**
 * Function to create a new incident (incident table)
 */
function save_incident(data) {
    if (data.correlation_id) {
        var existing_incident = null;
        // Do not create the incident if there is not related CI found
        if (data.sys_id) {
            existing_incident = find_incident(data.correlation_id, data.sys_id);
        }
        if (existing_incident && data.status == 6) return close_incident(existing_incident, data);
        else if (existing_incident) return update_incident(existing_incident, data);
    }
    return create_incident(data);
}

function find_incident(correlation_id, entity_sys_id) {
    var incident_GR = new GlideRecord("incident");
    var query = "correlation_id=" + GlideStringUtil.escapeQueryTermSeparator(correlation_id) + "^cmdb_ci=" + GlideStringUtil.escapeQueryTermSeparator(entity_sys_id);
    incident_GR.addEncodedQuery(query);
    incident_GR.query();
    if (incident_GR.next()) {
        return incident_GR;
    } else return null;
}


function create_incident(data) {
    if (data.status != 6) {
        var incident_GR = new GlideRecord('incident');
        incident_GR.initialize();

        incident_GR.category = "network";
        incident_GR.state = data.status;

        incident_GR.impact = data.impact;
        incident_GR.urgency = data.urgency;
        incident_GR.correlation_id = data.correlation_id;
        incident_GR.cause = data.cause;
        incident_GR.short_description = data.short_description;
        incident_GR.description = data.description;
        if (data.sys_id) incident_GR.cmdb_ci = data.sys_id;
        incident_GR.caller_id = gs.getUserID();
        var incident_sys_id = incident_GR.insert();
        return incident_sys_id;
    }
    return null;
}

function update_incident(incident_GR, data) {
    if (incident_GR) {
        incident_GR.state = data.status;
        incident_GR.comments_and_work_notes = "Update from Service Graph Connector for Juniper MIST:\n" + data.description;
        incident_GR.update();
        return incident_GR.sys_id;
    } else {
        return create_incident(data);
    }
}

function close_incident(incident_GR, data) {
    if (incident_GR) {

        incident_GR.state = 6;
        incident_GR.close_notes = "Received Marvis validation";
        incident_GR.close_code = "Solution provided";
        if (!incident_GR.assigned_to) incident_GR.assigned_to = gs.getUserID();
        incident_GR.comments_and_work_notes = "Updated by Service Graph Connector for Juniper MIST";
        incident_GR.update();

        return incident_GR.sys_id;
    } else {
        return null;
    }
}
