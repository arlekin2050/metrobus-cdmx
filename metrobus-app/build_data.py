#!/usr/bin/env python3
"""Pre-process GTFS data to extract Metrobús-only JSON for the web app."""
import csv
import json
import os

GTFS_DIR = os.path.join(os.path.dirname(__file__), '..', 'gtfs_files')

def read_csv(filename):
    path = os.path.join(GTFS_DIR, filename)
    with open(path, 'r', encoding='utf-8-sig') as f:
        return list(csv.DictReader(f))

def time_to_seconds(t):
    """Convert HH:MM:SS or H:MM:SS to total seconds."""
    if not t:
        return 0
    parts = t.strip().split(':')
    if len(parts) != 3:
        return 0
    return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])

def main():
    print("Loading GTFS files...")
    routes = read_csv('routes.txt')
    trips = read_csv('trips.txt')
    stops = read_csv('stops.txt')
    stop_times = read_csv('stop_times.txt')
    shapes = read_csv('shapes.txt')
    calendar = read_csv('calendar.txt')
    frequencies = read_csv('frequencies.txt')

    # Filter Metrobús routes only (agency_id == 'MB')
    mb_routes = [r for r in routes if r['agency_id'] == 'MB']
    mb_route_ids = {r['route_id'] for r in mb_routes}
    print(f"Metrobús routes: {len(mb_routes)}")

    # Filter trips for MB routes
    mb_trips = [t for t in trips if t['route_id'] in mb_route_ids]
    mb_trip_ids = {t['trip_id'] for t in mb_trips}
    mb_shape_ids = {t['shape_id'] for t in mb_trips if t.get('shape_id')}
    print(f"Metrobús trips: {len(mb_trips)}")

    # Filter stop_times for MB trips
    mb_stop_times = [st for st in stop_times if st['trip_id'] in mb_trip_ids]
    mb_stop_ids = {st['stop_id'] for st in mb_stop_times}
    print(f"Metrobús stop_times: {len(mb_stop_times)}")

    # Filter stops, shapes, calendar, frequencies
    mb_stops = [s for s in stops if s['stop_id'] in mb_stop_ids]
    mb_shapes = [s for s in shapes if s['shape_id'] in mb_shape_ids]
    mb_service_ids = {t['service_id'] for t in mb_trips}
    mb_calendar = [c for c in calendar if c['service_id'] in mb_service_ids]
    mb_frequencies = [f for f in frequencies if f['trip_id'] in mb_trip_ids]

    # Build shapes dict: shape_id -> [[lat, lon], ...]
    shapes_dict = {}
    for s in mb_shapes:
        sid = s['shape_id']
        if sid not in shapes_dict:
            shapes_dict[sid] = []
        shapes_dict[sid].append({
            'seq': int(s['shape_pt_sequence']),
            'lat': float(s['shape_pt_lat']),
            'lon': float(s['shape_pt_lon'])
        })
    for sid in shapes_dict:
        shapes_dict[sid].sort(key=lambda x: x['seq'])
        shapes_dict[sid] = [[p['lat'], p['lon']] for p in shapes_dict[sid]]

    # Build stop_times grouped by trip_id, with times in seconds
    stop_times_dict = {}
    for st in mb_stop_times:
        tid = st['trip_id']
        if tid not in stop_times_dict:
            stop_times_dict[tid] = []
        stop_times_dict[tid].append({
            'stop_id': st['stop_id'],
            'seq': int(st['stop_sequence']),
            'arr': time_to_seconds(st.get('arrival_time', '')),
            'dep': time_to_seconds(st.get('departure_time', ''))
        })
    for tid in stop_times_dict:
        stop_times_dict[tid].sort(key=lambda x: x['seq'])

    # Build stops dict
    stops_dict = {}
    for s in mb_stops:
        stops_dict[s['stop_id']] = {
            'name': s['stop_name'],
            'lat': float(s['stop_lat']),
            'lon': float(s['stop_lon']),
            'wheelchair': int(s.get('wheelchair_boarding', 0) or 0)
        }

    # Build routes with trips, including stop_times with real seconds
    routes_out = []
    for r in mb_routes:
        route_trips = [t for t in mb_trips if t['route_id'] == r['route_id']]

        # Get unique shape_ids
        seen_shapes = set()
        route_shapes = []
        for t in route_trips:
            sid = t.get('shape_id', '')
            if sid and sid not in seen_shapes:
                seen_shapes.add(sid)
                route_shapes.append(sid)

        # Build trip info (deduplicated by shape+direction)
        trip_list = []
        seen = set()
        for t in route_trips:
            key = (t.get('shape_id', ''), t.get('direction_id', ''))
            if key in seen:
                continue
            seen.add(key)

            tid = t['trip_id']
            trip_stops = stop_times_dict.get(tid, [])

            # Include stop times with seconds for simulation
            stops_with_times = []
            for s in trip_stops:
                stops_with_times.append({
                    'id': s['stop_id'],
                    'arr': s['arr'],  # seconds from trip start
                    'dep': s['dep']
                })

            trip_list.append({
                'trip_id': tid,
                'headsign': t.get('trip_headsign', ''),
                'direction': t.get('direction_id', ''),
                'shape_id': t.get('shape_id', ''),
                'service_id': t.get('service_id', ''),
                'stops': stops_with_times
            })

        routes_out.append({
            'route_id': r['route_id'],
            'short_name': r.get('route_short_name', ''),
            'long_name': r.get('route_long_name', ''),
            'color': r.get('route_color', 'E94560'),
            'text_color': r.get('route_text_color', 'FFFFFF'),
            'trips': trip_list,
            'shape_ids': route_shapes
        })

    # Frequencies dict
    freq_dict = {}
    for f in mb_frequencies:
        tid = f['trip_id']
        if tid not in freq_dict:
            freq_dict[tid] = []
        freq_dict[tid].append({
            'start': time_to_seconds(f['start_time']),
            'end': time_to_seconds(f['end_time']),
            'headway': int(f['headway_secs'])
        })

    # Calendar dict
    cal_dict = {}
    for c in mb_calendar:
        cal_dict[c['service_id']] = {
            'mon': int(c['monday']), 'tue': int(c['tuesday']),
            'wed': int(c['wednesday']), 'thu': int(c['thursday']),
            'fri': int(c['friday']), 'sat': int(c['saturday']),
            'sun': int(c['sunday']),
            'start': c['start_date'], 'end': c['end_date']
        }

    output = {
        'routes': routes_out,
        'stops': stops_dict,
        'shapes': shapes_dict,
        'calendar': cal_dict,
        'frequencies': freq_dict
    }

    out_path = os.path.join(os.path.dirname(__file__), 'metrobus_data.json')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False)

    size_mb = os.path.getsize(out_path) / (1024 * 1024)
    print(f"\nOutput: {out_path} ({size_mb:.1f} MB)")
    print(f"Routes: {len(routes_out)}, Stops: {len(stops_dict)}, Shapes: {len(shapes_dict)}")

    # Print trip durations for verification
    for r in routes_out:
        print(f"\n--- {r['short_name']}: {r['long_name']} ---")
        for t in r['trips']:
            if t['stops']:
                duration = t['stops'][-1]['arr']
                mins = duration // 60
                print(f"  {t['headsign']:40s} {mins}min ({len(t['stops'])} stops) shape={t['shape_id']}")

if __name__ == '__main__':
    main()
