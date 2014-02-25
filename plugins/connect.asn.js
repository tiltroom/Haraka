// determine the ASN of the connecting IP

var dns = require('dns');
var net_utils = require('./net_utils');

var test_ip = '208.75.177.99';
var providers = [];
var conf_providers = [ 'origin.asn.cymru.com', 'asn.routeviews.org' ];

exports.register = function () {
    var plugin = this;

    // get settings from the config file
    var config = plugin.config.get('connect.asn.ini');
    if (config.main.providers) {
        conf_providers = config.main.providers.split(/[\s,;]+/);
    }
    if (config.main.test_ip) { test_ip = config.main.test_ip; }

    // add working providers to the provider list
    var result_cb = function (zone, res) {
        if (res) {
            plugin.loginfo(plugin, zone + " succeeded");
            providers.push(zone);
        }
        else {
            plugin.logerror(plugin, zone + " failed");
        }
    };

    // test each provider
    for (var i=0; i < conf_providers.length; i++) {
        plugin.get_dns_results(conf_providers[i], test_ip, result_cb);
    }
};

exports.get_dns_results = function (zone, ip, cb) {
    var plugin = this;
    var query = ip.split('.').reverse().join('.') + '.' + zone;
    plugin.logdebug(plugin, "query: " + query);

    dns.resolveTxt(query, function (err, addrs) {
        if (err) {
            plugin.logerror(plugin, "error: " + err + ' running: '+query);
            return cb(zone, false);
        }

        for (var i=0; i < addrs.length; i++) {
            plugin.logdebug(plugin, zone + " answer: " + addrs[i]);
            if (zone === 'origin.asn.cymru.com') {
                return cb(zone, plugin.parse_cymru(addrs[i]));
            }
            else if (zone === 'asn.routeviews.org') {
                return cb(zone, plugin.parse_routeviews(addrs[i]));
            }
            else {
                plugin.logerror(plugin, "unrecognized ASN provider: " + zone);
                return cb(zone, '');
            }
        }
    });
};

exports.hook_lookup_rdns = function (next, connection) {
    var plugin = this;
    var ip = connection.remote_ip;
    if (net_utils.is_rfc1918(ip)) return next();

    var pending = 0;
    var result_cb = function (zone, r) {
        pending--;
        if (!r && pending === 0) return next();

        // store asn & net from any source
        if (r[0]) connection.results.add(plugin, {asn: r[0]});
        if (r[1]) connection.results.add(plugin, {net: r[1]});

        // store provider specific results
        if (zone === 'origin.asn.cymru.com') {
            connection.results.add(plugin, { emit: true,
                cymru: {asn: r[0], net: r[1], country: r[2], authority: r[3]},
            });
        }
        else if (zone === 'asn.routeviews.org') {
            connection.results.add(plugin, { emit: true,
                routeviews: {asn: r[0], net: r[1] },
            });
        }
        if (pending === 0) return next();
    };

    for (var i=0; i < providers.length; i++) {
        var zone = providers[i];
        connection.logdebug(plugin, "zone: " + zone);

        pending++;
        plugin.get_dns_results(zone, ip, result_cb);
    }

    if (pending === 0) return next();
};

exports.parse_routeviews = function (str) {
    var plugin = this;
    var r = str.split(/ /);
    if (r.length !== 3) {
        plugin.logerror(plugin, "result length not 3: " + r.length + ' string="' + str + '"');
        return '';
    }
    return r;
};

exports.parse_cymru = function (str) {
    var plugin = this;
    var r = str.split(/\s+\|\s+/);
    //  99.177.75.208.origin.asn.cymru.com. 14350 IN TXT "40431 | 208.75.176.0/21 | US | arin | 2007-03-02"
    // handle this: cymru: result 4:              string="10290 | 12.129.48.0/24 | US | arin |"
    if (r.length < 4) {
        plugin.logerror(plugin, "cymru: bad result length " + r.length + ' string="' + str + '"');
        return '';
    }
    return r;
};

exports.hook_data_post = function (next, connection) {
    var plugin = this;
    var asn = connection.results.get('connect.asn');
    if (!asn) return next();
    var txn = connection.transaction;
    var config = plugin.config.get('connect.asn.ini');

    if (asn.asn && config.main.asn_header) {
        if (asn.net) {
            txn.add_header('X-Haraka-ASN', asn.asn + ' ' + asn.net);
        }
        else {
            txn.add_header('X-Haraka-ASN', asn.asn);
        }
    }

    if (config.main.provider_header) {
        for (var p in asn) {
            if (!asn[p].asn) {   // ignore non-object results
                connection.loginfo(plugin, p + ", " + asn[p]);
                continue;
            }
            var name = 'X-Haraka-ASN-' + p.toUpperCase();
            var values = [];
            for (var k in asn[p]) {
                values.push(k + '=' + asn[p][k]);
            }
            txn.add_header(name, values.join(' '));
        }
    }
    return next();
};

exports.hook_data_post = function (next, connection) {
    var txn = connection.transaction;
    if (!connection.notes.asn) return next();
    for (var l in connection.notes.asn) {
       var name = l[0].toUpperCase() + l.slice(1);
       name = 'X-Haraka-ASN-' + name;
       var values = [];
       for (var k in connection.notes.asn[l]) {
           values.push(k + '=' + connection.notes.asn[l][k]);
       }
       txn.add_header(name, values.join(' '));
   }
   return next();
};
