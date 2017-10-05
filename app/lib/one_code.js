var turf = require('@turf/turf');
var polyUtil = require('polyline-encoded');
var request = require("request");
var Promise = require("promise");


//DATASETS
    //ELEVATION
    var elevation = require('./data/elevation_SGP.json');
    var origin = [103.6, 1.16];
    var pixel_size = 0.0002; // Pixels are squares
    //PCN NETWORK
    var pcn_access_points = require('./data/bb_pcn_access_points.json');
    var pcn = require('./data/bb_pcn.json');
    var national_parks = require('./data/bb_parks.json');


//------------------------------- INTERNAL SERVER CALLS TO ONEMAP ---------------------------------------------------//
function routeReq(start, end, mode) {
    var start_point = start.slice().reverse();
    var end_point = end.slice().reverse();
    var mode = mode;

    var route_options = {
        method: "GET",
        url: "http://onemap.duckdns.org/onemap/route",
        qs: {
            start: start_point.toString(),
            end: end_point.toString(),
            routeType: mode
        }
    };

    function async() {
        return new Promise(function (resolve, reject) {
            request(route_options, function (err, response, body) {
                if (err) {
                    return reject(err);
                }
                // console.log(response.statusCode);
                else {
                    return resolve(body);
                }
            });
        });
    }

    return async().then(function (body) {

        var result = JSON.parse(body);

        function feature_from_api(featurejson) {
            var properties = {
                "route_instructions": featurejson["route_instructions"],
                "route_name": featurejson["route_name"],
                "route_summary": featurejson["route_summary"]
            };
            var encoded = featurejson["route_geometry"];
            if (encoded !== undefined || encoded !== '' || encoded != null) {
                var latlngs = polyUtil.decode(encoded);
                var coords = latlngs.map(function (list) {
                    return list.slice().reverse();
                });
            } else {
                coords = [];
            }
            return turf.lineString(coords, properties);
        }

        var parsed_result = {
            main: feature_from_api(result)
        };
        return parsed_result;
    }).catch(function (err) {
        console.log("%s", err);
    });
}

//--------------------------------------------------------------------------------------------------------------------//

//---------------------------------------- ELEVATION & DIFFICULTY FUNCTIONS ------------------------------------------//

/**
 * Converts a GeoJSON point to a pixel based on the
 * Singapore elevation map from NASA's data. Coordinates
 * are snapped to the bottom left of each pixel.
 * Assumes given point is within the map, otherwise UB
 *
 * @param p    point (long, lat)
 * @return        Pos of corresponding pixel in 0-indexed 2D array
 */
function pointToPixel(p) {
    // return [Math.floor((p.coordinates[0] - origin[0])/pixel_size),
    //     Math.floor((p.coordinates[1] - origin[1])/pixel_size)];
    return [Math.floor((p[0] - origin[0]) / pixel_size),
        Math.floor((p[1] - origin[1]) / pixel_size)];
}

function lonlatToPixel(pair) {
    return [Math.floor((pair[0] - origin[0]) / pixel_size),
        Math.floor((pair[1] - origin[1]) / pixel_size)];
}

/**
 * Obtains the elevation of a given point by querying
 * the database
 *
 * @param p    point
 * @return        Elevation of point, in metres
 */

function getElevation(p) {
    var pixelLoc = pointToPixel(p);
    return elevation[pixelLoc[0]][pixelLoc[1]];
}

function getElevationFromCoords(pair) {
    var pixelcoords = lonlatToPixel(pair);
    return elevation[pixelcoords[0]][pixelcoords[1]];
}


/**
 * Extract the climbs from a route. A climb is stored as
 * a tuple of (<start>, <end>), where each marker consists
 * of geographical data in the form (<point>, <elevation>)
 *
 * @param route    A line of points, representing the route
 * @return            An array of climbs along the route
 */
function getClimbs(route) {
    var elevations = route.map(getElevationFromCoords);
    var step_size = 1; // Define sampling rate
    // Initialize
    var climbs = [];
    var climb_start = 0;
    var work_done = 0;
    var climbing = false;
    for (var i = step_size, len = route.length; i < len; i += step_size) {
        if (climbing && elevations[climb_start] <= elevations[i]) {
            // Climb ended, record it
            climbing = false;
            climbs.push([[route[climb_start], elevations[climb_start]],
                [route[i], elevations[i]]]);
        } else if (!climbing && elevations[i] > elevations[i - step_size]) {
            // Start a climb
            climbing = true;
            climb_start = i - step_size;
        }
    }
    return climbs;
}

// Define the difficulties
var level = [[0.25, 0.25], [0.5, 0.5], [1, 1]];

/**
 * Gets the difficulty of a climb.
 *
 * The intuition is that every climb requires a
 * sustained effort over time, and thus can be
 * represented by a point on the <Time>/<Power> graph.
 * The maximum time a human can sustain a particular
 * level of effort can be approximated by the
 * curve: <Time> = k/<Power> + c
 * This curve shifts out with increasing athletic
 * ability.
 * <Time> = <dist> / <a constant>
 * <grade> = <rise> / <dist>
 * <Power> = <grade> * <a constant>
 *
 * Therefore we can consider <dist> = k/<grade> + c
 * and define 3 difficulty regions by calibrating the
 * constants k and c
 *        Lvl 1: k = 1, c = 1
 *        Lvl 2: k = 2, c = 2
 *        Lvl 3: k = 3, c = 3
 *
 * A climb (i.e. a (<grade>, <dist>) point) bounded
 * by the difficulty curve and the axes is considered
 * suitable for that level of difficulty.
 * The difficulty of said climb will be the closest
 * suitable difficulty.
 *
 * Source: https://www.wired.com/2013/03/whats-the-steepest-gradient-for-a-road-bike/
 *
 * @param climb    The climb to analyse
 * @return            The difficulty of the climb [1-5]
 */
function getClimbDifficulty(climb) {
    //turfjs distance is in km
    var dist = turf.distance(turf.point(climb[0][0]), turf.point(climb[1][0]), "kilometers");
    var grade = (climb[1][1] - climb[0][1]) / dist;
    var maxLevel = level.length;
    for (var i = 0; i < maxLevel; i++) {
        //Within difficulty i+1?
        if (dist <= level[i][0] / grade + level[i][1]) {
            return i + 1;
        }
    }
    // Off the charts difficulty, return highest difficulty
    return maxLevel;
}

/**
 * Returns the difficulty of a route
 *
 * @param route    A line
 * @return            The difficulty level of the route
 */
function getRouteDifficulty(route) {
    var climbs = getClimbs(route);
    // console.log(climbs);
    if (climbs.length === 0) {
        return 1;
    } else {
        return Math.max(...climbs.map(getClimbDifficulty));
    }
}

//--------------------------------------------------------------------------------------------------------------------//

//---------------------------------------- GEOOBJECTS PROCESSING------------------------------------------------------//
//Helper Functions
function isPointonLine(line, point) {
    var snapped_point = turf.pointOnLine(line, point, 'kilometers')
    return snapped_point["properties"]["dist"] < 0.000001;
}

function isSamePoint(point1, point2) {
    var point1_coords = turf.getCoord(point1);
    var point2_coords = turf.getCoord(point2);
    return Math.abs(point1_coords[0] - point2_coords[0]) < 0.0001 && Math.abs(point1_coords[1] - point2_coords[1]) < 0.0001;
}

//Routing Functions

// REGION OF INTEREST BASED

function regionofInterest(pt, radius) {
    var circle_around_point = turf.circle(pt, radius, 10);
    return turf.featureCollection([circle_around_point]);
}

function getPointsinROI(ROI, dataset) {
    return turf.within(dataset, ROI);
}

// INTERMEDIATES

function getRoutesfromEntryPoints(entry_pts) {
    var routes_array = [];
    var pts_array = entry_pts["features"];
    var lines_array = pcn["features"];
    for (var i = 0; i < lines_array.length; i++) {
        for (var j = 0; j < pts_array.length; j++) {
            if (isPointonLine(lines_array[i], pts_array[j])) {
                routes_array.push(lines_array[i]);
            }
        }
    }

    return turf.featureCollection(routes_array);
}

function appendDifficultytoRoutes(routesArray) {
    for (var i = 0; i < routesArray.length; i++) {
        var route = routesArray[i]["features"][0];
        var difficulty = getRouteDifficulty(turf.getCoords(route));
        route["difficulty"] = difficulty;
        //console.log(route["difficulty"]);
    }
    return routesArray;
}

function appendDistancetoRoutes(routesArray) {
    for (var i = 0; i < routesArray.length; i++) {
        var route = routesArray[i]["features"][0];
        var distance = turf.lineDistance(route, 'kilometers');
        route["distance"] = distance;
        //console.log(route["distance"]);
    }
    return routesArray;
}

function filterbyDifficulty(diff, routesArray) {
    var filteredroutes = [];
    for (var i = 0; i < routesArray.length; i++) {
        var route = routesArray[i]["features"][0];
        if (route["difficulty"] === diff) {
            filteredroutes = routesArray[i].concat(filteredroutes);
        } else if (route["difficulty"] < diff) {
            filteredroutes.push(routesArray[i]);
        }
    }

    return routesArray;
}

function filterbyDistance(dist, routesArray) {
    var filteredroutes = [];
    for (var i = 0; i < routesArray.length; i++) {
        var route = routesArray[i]["features"][0];
        if (route["distance"] === dist) {
            filteredroutes = routesArray[i].concat(filteredroutes);
        } else if (route["distance"] < dist) {
            filteredroutes.push(routesArray[i]);
        }
    }

    return routesArray;
}
function getSameRoutes(routefeatCol1, routefeatCol2) {
    var route1 = routefeatCol1["features"];
    var route2 = routefeatCol2["features"];
    var routes = [];
    var routes_id = [];
    for (var i = 0; i < route1.length; i++) {
        for (var j = 0; j < route2.length; j++) {
            if (route1[i].id === route2[j].id && !routes_id.includes(route1[i].id)) {
                routes.push(route1[i]);
                routes_id.push(route1[i].id);
            }
        }
    }
    return turf.featureCollection(routes);
}

function connectRoutes(start_pt, end_pt, mode, route_array) {
    var start_coords = turf.getCoord(start_pt);
    var end_coords = turf.getCoord(end_pt);
    var promise_array = [];
    for (var i = 0; i < route_array.length; i++) {
        var pcn_entry = route_array[i]["features"][1];
        var pcn_exit = route_array[i]["features"][2];
        var route = route_array[i]["features"][0];

        var pcn_entry_coords = turf.getCoord(pcn_entry);
        var pcn_exit_coords = turf.getCoord(pcn_exit);
        var sliced_route = turf.lineSlice(pcn_entry, pcn_exit, route);
        var sliced_pcn_coords = [];
        if (isSamePoint(turf.point(turf.getCoords(sliced_route)[0]), pcn_entry_coords)) {
            sliced_pcn_coords = turf.getCoords(sliced_route);
        } else {
            sliced_pcn_coords = turf.getCoords(sliced_route).slice().reverse();
        }
        //create promise array
        var route_promise_arr = [routeReq(start_coords, pcn_entry_coords, mode), routeReq(pcn_exit_coords, end_coords, mode), sliced_pcn_coords];
        //returns a promise chain
        promise_array[i] = Promise.all(route_promise_arr).then(function (res) {
            var starting_route_coords = turf.getCoords(res[0]["main"]);
            var ending_route_coords = turf.getCoords(res[1]["main"]);
            return starting_route_coords.concat(res[2], ending_route_coords);
        });
    }
    return Promise.all(promise_array).then(function (res) {
        for (var i = 0; i < res.length; i++) {
            route_array[i]["features"][0].geometry.coordinates = res[i];
        }
        return route_array;
    });
}


// Formatting functions

function routestoFeatureCollectionArray(routes, entry_points, exit_points) {
    var featCol_array = [];
    var entry_pts_array = entry_points["features"];
    var exit_pts_array = exit_points["features"];
    var lines_array = routes["features"];
    for (var i = 0; i < lines_array.length; i++) {
        featCol_array[i] = [lines_array[i]];
        for (var j = 0; j < entry_pts_array.length; j++) {
            if (isPointonLine(lines_array[i], entry_pts_array[j]) && featCol_array[i].length === 1) {
                featCol_array[i].push(entry_pts_array[j]);
            }
        }
    }

    for (var i = 0; i < lines_array.length; i++) {
        for (var j = 0; j < exit_pts_array.length; j++) {
            if (isPointonLine(lines_array[i], exit_pts_array[j]) && featCol_array[i].length === 2
                && exit_pts_array[j] !== featCol_array[i][1]) {
                featCol_array[i].push(exit_pts_array[j]);
            }
        }
        featCol_array[i] = turf.featureCollection(featCol_array[i]);
    }
    return featCol_array;
}


//--------------------------------------------------------------------------------------------------------------------//
// MAIN API HERE ------------------------------------------------------------------------------------------------------>
function getFeaturesonReq(mode, start_point, end_point, distance, difficulty) {
    var startPoint = turf.point(start_point);
    var startROI = regionofInterest(startPoint, distance / 2);

    var endPoint = turf.point(end_point);
    var endROI = regionofInterest(endPoint, distance / 2);

    var startEntryPoints = getPointsinROI(startROI, pcn_access_points);
    var endEntryPoints = getPointsinROI(endROI, pcn_access_points);
    var start_routes = getRoutesfromEntryPoints(startEntryPoints);
    var end_routes = getRoutesfromEntryPoints(endEntryPoints);
    var sameRoutes = getSameRoutes(start_routes, end_routes);
    var routeArray = routestoFeatureCollectionArray(sameRoutes, startEntryPoints, endEntryPoints);

    //async command
    return connectRoutes(startPoint, endPoint, mode, routeArray)
        .then(function (x) {
            return appendDifficultytoRoutes(x);
        })
        .then(function (x) {
            return appendDistancetoRoutes(x);
        })
        .then(function (x) {
            return filterbyDifficulty(difficulty, x);
        })
        .then(function (x) {
            return filterbyDistance(distance, x)
        });
}

exports.get_features = function (req, res) {
    var mode = req.query.mode;
    var start_point = req.query.start;
    var end_point = req.query.end;
    var distance = parseInt(req.query.dist);
    var difficulty = parseInt(req.query.diff);

    var sp_array = JSON.parse("[" + start_point + "]");
    var ep_array = JSON.parse("[" + end_point + "]");

    getFeaturesonReq(mode, sp_array, ep_array, distance, difficulty).then(function (result) {
        console.log(result);
        res.send(result);
    }).catch(function (err) {
        console.log("%s", err);
    });
};