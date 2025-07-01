// server.js
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const admin = require("firebase-admin");

// Load environment variables from .env
dotenv.config();
const stripe = require('stripe')(process.env.PATMENT_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());



const serviceAccount = require("./trusted-shift-firebase-adminsdk.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});



const uri = `mongodb+srv://${process.env.DB_NAME}:${process.env.DB_PASS}@cluster0.dclhmji.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {

    const db = client.db('trustedParcelShift');
    usersCollection = db.collection('users');
    riderCollection = db.collection('riders');
    parcelsCollection = db.collection('parcels');
    paymentsCollection = db.collection('payment')


    const verifyToken = async (req, res, next) => {
      const authHeaters = req.headers.authorization;
      // console.log('auth',authHeaters);
      if (!authHeaters) {
        return res.status(401).send({ message: 'unauthorized access' })
      }

      const token = authHeaters.split(' ')[1]

      if (!token) {
        return res.status(401).send({ message: 'unauthorized access' })
      }

      //  verify the token
      try {
        const decoded = await admin.auth().verifyIdToken(token)
        req.decoded = decoded
        next()
      }
      catch (error) {
        return res.status(403).send({ message: 'forbidden access' })
      }

    }

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email
      const query = { email }

      const user = await usersCollection.findOne(query)

      if (!user || user.role !== 'admin') {
        return res.status(403).send({ message: 'forbidden access' })
      }

      next()
    }

    app.post('/users', async (req, res) => {
      const email = req.body.email
      const userData = req.body

      const existingUser = await usersCollection.findOne({ email })

      if (existingUser) {
        return res.status(400).json({ message: "Email already exists" });
      }

      const result = await usersCollection.insertOne(userData)
      res.send(result)

    })

    // search users (partial match on name/email)
    app.get('/users', async (req, res) => {
      const { search = '' } = req.query;
      const regex = new RegExp(search, 'i');           // case‑insensitive
      const users = await usersCollection
        .find({ $or: [{ name: regex }, { email: regex }] })
        .limit(10)                                     // pagination optional
        .toArray();
      res.send(users);
    });

    // toggle role
    app.patch('/users/role/:id', verifyToken, verifyAdmin, async (req, res) => {
      const { role } = req.body;                       // 'admin' or 'user'
      const result = await usersCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: { role } }
      );
      res.send(result);
    });

    // GET /users/role?email=someone@example.com
    app.get('/users/role', async (req, res) => {
      const email = req.query.email;

      if (!email) {
        return res.status(400).send({ error: 'Email is required' });
      }
      const user = await usersCollection.findOne({ email });

      if (user) {
        res.send({ role: user.role || 'user' });
      } else {
        res.send({ role: 'user' });
      }
    });



    // create rider
    app.post('/riders', async (req, res) => {
      const newRider = req.body;
      const { email } = req.body

      const existingRider = await riderCollection.findOne({ email })
      if (existingRider) {
        return res.status(400).json({ message: "Email already exists" });
      }

      const result = await riderCollection.insertOne(newRider)
      res.send(result)
    })

    // get pending rider
    app.get('/riders/pending', verifyToken, verifyAdmin, async (req, res) => {
      try {
        const pendingRiders = await riderCollection.find({ status: "pending" }).toArray();
        res.send(pendingRiders);
      } catch (error) {
        console.error('Error fetching pending riders:', error);
        res.status(500).send({ message: 'Failed to fetch pending riders' });
      }
    });

    // accept rider or reject or Deactivate
    app.patch('/riders/:id', async (req, res) => {
      const id = req.params.id;
      const { status, email } = req.body
      const result = await riderCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status } }
      );
      if (status === 'approved') {
        const userQuery = { email }
        const userUpdatedDoc = {
          $set: {
            role: "rider"
          }
        }
        const roleResult = await usersCollection.updateOne(userQuery, userUpdatedDoc)
        console.log(roleResult.modifiedCount);
      }
      res.send(result);
    });

    //  get approved riders 
    app.get('/riders/approved', verifyToken, verifyAdmin, async (req, res) => {
      const riders = await riderCollection.find({ status: "approved" }).toArray();
      res.send(riders);
    });

    app.get('/riders/available', async (req, res) => {
      const district = req.query.district;
      const riders = await riderCollection.find({
        district,
        // status: 'active'
      }).toArray();
      res.send(riders);
    });


    app.patch('/assign-rider', async (req, res) => {
      const { parcelId, riderId } = req.body;

      if (!parcelId || !riderId) {
        return res.status(400).send({ error: 'parcelId and riderId are required' });
      }

      try {
        // 1. Update parcel's delivery status
        const parcelUpdate = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              delivery_status: 'in-transit',
              // assigned_rider: new ObjectId(riderId),
            },
          }
        );

        // 2. Update rider's work status
        const riderUpdate = await riderCollection.updateOne(
          { _id: new ObjectId(riderId) },
          {
            $set: {
              work_status: 'in-delivery',
            },
          }
        );

        if (parcelUpdate.modifiedCount > 0 && riderUpdate.modifiedCount > 0) {
          res.send({ success: true, message: 'Rider assigned successfully' });
        } else {
          res.status(400).send({ success: false, message: 'Update failed' });
        }
      } catch (error) {
        res.status(500).send({ error: 'Server error while assigning rider' });
      }
    });




    // get all parcel
    app.get('/allparcel', async (req, res) => {
      const result = await parcelsCollection.find().toArray()
      res.send(result)
    })

    // get my Parcels
    app.get('/myparcels', verifyToken, async (req, res) => {
      const email = req.query.email;     // e.g. /parcels?email=user@example.com
      const query = email ? { created_by: email } : {};

      try {
        const parcels = await parcelsCollection
          .find(query)
          .sort({ creation_date: -1 })
          .toArray();

        res.send(parcels);
      } catch (error) {
        res.status(500).send({ success: false, message: 'Failed to fetch parcels' });
      }
    });

    // parcels for assign
    app.get('/parcels/assigned', async (req, res) => {
      try {
        const filter = {
          payment_status: "paid",
          delivery_status: "not-collected"
        };

        const parcels = await parcelsCollection.find(filter).toArray();
        res.send(parcels);
      } catch (error) {
        console.error("Error fetching assigned parcels:", error);
        res.status(500).send({ message: "Internal Server Error" });
      }
    });


    // get spacific parcel by id
    app.get('/parcels/:id', async (req, res) => {
      const id = req.params.id;

      try {
        const parcel = await parcelsCollection.findOne({ _id: new ObjectId(id) });

        if (parcel) {
          res.send(parcel);
        } else {
          res.status(404).send({ message: 'Parcel not found' });
        }
      } catch (error) {
        res.status(500).send({ message: 'Error fetching parcel', error: error.message });
      }
    });


    // POST: Save parcel
    app.post('/parcels', async (req, res) => {
      const parcel = req.body;
      const result = await parcelsCollection.insertOne(parcel);
      res.send(result)
    });

    // delete parcel
    app.delete('/parcels/:id', async (req, res) => {
      const id = req.params.id;

      try {
        const result = await parcelsCollection.deleteOne({ _id: new ObjectId(id) });

        if (result.deletedCount > 0) {
          res.send({ success: true, result });
        } else {
          res.status(404).send({ success: false, message: 'Parcel not found' });
        }
      } catch (error) {
        res.status(500).send({ success: false, message: 'Error deleting parcel' });
      }
    });


    // payment intent
    app.post('/create-payment-intent', async (req, res) => {
      const priceInCents = req.body.priceInCents
      const paymentIntent = await stripe.paymentIntents.create({
        amount: priceInCents, // amount in cents
        currency: 'usd',
        automatic_payment_methods: { enabled: true },
      });

      res.json({ clientSecret: paymentIntent.client_secret });
    });


    // update payment_status & create payment history
    app.post('/payments', async (req, res) => {
      const { parcelId, amount, transactionId, paidBy } = req.body;

      try {
        // 1. Update the parcel
        const updateResult = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              payment_status: 'paid'
            }
          }
        );

        if (updateResult.modifiedCount === 0) {
          return res.status(404).send({ success: false, message: 'Parcel not found or already paid' });
        }
        // 2. Insert payment history
        const paymentDoc = {
          parcelId,
          amount,
          transactionId,
          paidBy,
          dateStr: new Date().toISOString(),
          paymentDate: new Date(),
        };

        const insertResult = await paymentsCollection.insertOne(paymentDoc);
        res.send({
          success: true,
          message: 'Payment recorded successfully',
          paymentId: insertResult.insertedId,
        });

      } catch (error) {
        console.error('Error recording payment:', error);
        res.status(500).send({ success: false, message: 'Server error' });
      }
    });


    // get payment history for logged in user
    app.get('/payments', verifyToken, async (req, res) => {
      const email = req.query.email;

      // console.log(req.decoded.email);
      if (!email) {
        return res.status(400).send({ success: false, message: 'Missing email' });
      }

      try {
        const payments = await paymentsCollection
          .find({ paidBy: email })
          .sort({ paymentDate: -1 }) // latest first
          .toArray();

        res.send(payments);
      } catch (error) {
        res.status(500).send({ success: false, message: 'Error fetching payments' });
      }
    });



    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    // console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);


app.get('/', (req, res) => {
  res.send('sent parcel successfully!');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});