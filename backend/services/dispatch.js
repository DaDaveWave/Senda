import { supabase } from './supabase.js';
import { zipToCoords, haversineDistance } from './geo.js';

// Returns contractors sorted by distance, filtered by their travel radius opt-in
export async function findContractors(trade, zip, excludeIds = []) {
  const homeCoords = await zipToCoords(zip);
  if (!homeCoords) return { contractors: [], homeCoords: null };

  let query = supabase
    .from('contractors')
    .select('*')
    .eq('trade', trade)
    .eq('is_active', true)
    .eq('is_available', true)
    .not('lat', 'is', null)
    .not('lng', 'is', null);

  if (excludeIds.length) {
    query = query.not('id', 'in', `(${excludeIds.join(',')})`);
  }

  const { data: contractors, error } = await query;
  if (error || !contractors?.length) return { contractors: [], homeCoords };

  const eligible = contractors
    .map((c) => ({
      ...c,
      distance: haversineDistance(homeCoords.lat, homeCoords.lng, c.lat, c.lng),
    }))
    .filter((c) => c.distance <= (c.travel_radius_miles || 25))
    .sort((a, b) => a.distance - b.distance);

  return { contractors: eligible, homeCoords };
}
