import csv,json,sys,datetime as dt
from zoneinfo import ZoneInfo
TZ=ZoneInfo('Europe/Kyiv')
AREAS={
 'chernihiv':  lambda o,ra:o=='Chernihivska oblast' and ra in('','Chernihivskyi raion'),
 'brovary':    lambda o,ra:o=='Kyivska oblast' and ra in('','Brovarskyi raion'),
 'kyiv':       lambda o,ra:o=='Kyiv City',
 'nizhyn':     lambda o,ra:o=='Chernihivska oblast' and ra in('','Nizhynskyi raion'),
 'novhorod':   lambda o,ra:o=='Chernihivska oblast' and ra in('','Novhorod-Siverskyi raion'),
 'prylutskyi': lambda o,ra:o=='Chernihivska oblast' and ra in('','Prylutskyi raion'),
 'koriukivka': lambda o,ra:o=='Chernihivska oblast' and ra in('','Koriukivskyi raion'),
 'lviv':       lambda o,ra:o=='Lvivska oblast' and ra in('','Lvivskyi raion'),
 'rivne':      lambda o,ra:o=='Rivnenska oblast' and ra in('','Rivnenskyi raion'),
 'zhytomyr':   lambda o,ra:o=='Zhytomyrska oblast' and ra in('','Zhytomyrskyi raion'),
 'ternopil':   lambda o,ra:o=='Ternopilska oblast' and ra in('','Ternopilskyi raion'),
 'khmelnytskyi':lambda o,ra:o=='Khmelnytska oblast' and ra in('','Khmelnytskyi raion'),
 'vinnytsia':  lambda o,ra:o=='Vinnytska oblast' and ra in('','Vinnytskyi raion'),
 'kyivobl':    lambda o,ra:o=='Kyivska oblast' and ra in('','Buchanskyi raion','Fastivskyi raion'),
}
iv={k:[] for k in AREAS}
p=lambda s:dt.datetime.fromisoformat(s)
lastend=None
for row in csv.DictReader(open(sys.argv[1])):
    if not row['finished_at']: continue
    a,b=p(row['started_at']),p(row['finished_at'])
    if b<=a or (b-a).total_seconds()>86400*2: continue
    lastend=max(lastend or b,b)
    for k,f in AREAS.items():
        if f(row['oblast'],row['raion']): iv[k].append((a,b))
def merge(L):
    L.sort(); out=[]
    for a,b in L:
        if out and a<=out[-1][1]: out[-1][1]=max(out[-1][1],b)
        else: out.append([a,b])
    return out
end=lastend
res={'data_until':end.astimezone(TZ).strftime('%d.%m.%Y'),'areas':{}}
def stats(m,start):
    # minutes under alert per (weekday,hour) and per hour; count of alert starts per hour
    hm=[[0.0]*24 for _ in range(7)]; starts=[0]*24; durs=[]
    for a,b in m:
        if b<start: continue
        a=max(a,start)
        durs.append((b-a).total_seconds()/60)
        starts[a.astimezone(TZ).hour]+=1
        t=a
        while t<b:
            lt=t.astimezone(TZ)
            nxt=(lt.replace(minute=0,second=0,microsecond=0)+dt.timedelta(hours=1)).astimezone(dt.timezone.utc)
            seg=min(nxt,b)
            hm[lt.weekday()][lt.hour]+=(seg-t).total_seconds()/60
            t=seg
    days=(end-start).days
    weeks=days/7
    hm_pct=[[round(100*x/(weeks*60),1) for x in d] for d in hm]
    hour_pct=[round(sum(hm[w][h] for w in range(7))/(days*60)*100,1) for h in range(24)]
    durs.sort()
    return {'hour_pct':hour_pct,'heat':hm_pct,'starts_per_hour':starts,'n':len(durs),
            'median_min':round(durs[len(durs)//2]) if durs else 0,'days':days,
            'per_day':round(len(durs)/days,2),'total_pct':round(sum(durs)/(days*1440)*100,1)}
for k in AREAS:
    m=merge(iv[k])
    monthly={}
    for a,b in m:
        key=a.astimezone(TZ).strftime('%Y-%m')
        monthly.setdefault(key,[0,0.0]); monthly[key][0]+=1; monthly[key][1]+=(b-a).total_seconds()/3600
    res['areas'][k]={'y1':stats(m,end-dt.timedelta(days=365)),'d90':stats(m,end-dt.timedelta(days=90)),
       'monthly':{k2:[v[0],round(v[1],1)] for k2,v in sorted(monthly.items())}}
json.dump(res,open(sys.argv[2],'w'),separators=(',',':'))
print('ok',res['data_until'],len(res['areas']))
